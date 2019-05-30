import { Mutex } from 'async-mutex';
import * as Bluebird from 'bluebird';
import * as retry from 'bluebird-retry';
import * as sdk from 'etcher-sdk';
import { EventEmitter } from 'events';
import * as Board from 'firmata';
import * as visuals from 'resin-cli-visuals';
import * as Stream from 'stream';
import { fs } from 'mz';

import { getDrive, exec } from '../helpers';
import NetworkManager, { Supported } from './nm';

/**
 * TestBot Hardware config
 */
const HW_SERIAL5: Board.SERIAL_PORT_ID = 5;
const BAUD_RATE = 9600;
const DEV_SD = '/dev/disk/by-id/usb-PTX_sdmux_HS-SD_MMC_1234-0:0';
const DEV_TESTBOT = '/dev/ttyACM0';

enum GPIO {
	WRITE_DAC_REG = 0x00,
	ENABLE_VOUT_SW = 0x03,
	DISABLE_VOUT_SW = 0x04,
	ENABLE_VREG = 0x07,
	ENABLE_FAULTRST = 0x10,
	SD_RESET_ENABLE = 0x12,
	SD_RESET_DISABLE = 0x13,
}

enum PINS {
	LED_PIN = 13,
	SD_MUX_SEL_PIN = 28,
	USB_MUX_SEL_PIN = 29,
}

/**
 * Signal handling function
 */
async function manageHandlers(
	handler: (signal: NodeJS.Signals) => Promise<void>,
	options: { register: boolean },
): Promise<void> {
	for (const signal of ['SIGINT', 'SIGTERM'] as Array<NodeJS.Signals>) {
		if (options.register) {
			process.on(signal, handler);
		} else {
			process.removeListener(signal, handler);
		}
	}
}

class TestBot extends EventEmitter implements Leviathan.Worker {
	private board: Board;
	private mutex: Mutex;
	private net?: NetworkManager;
	private disk?: string;
	private signalHandler: (signal: NodeJS.Signals) => Promise<void>;

	/**
	 * Represents a TestBot
	 */
	constructor(options: Leviathan.Options) {
		super();

		if (options != null && options.network != null) {
			this.net = new NetworkManager(options.network);
		}

		if (
			options != null &&
			options.worker != null &&
			options.worker.disk != null
		) {
			this.disk = options.worker.disk;
		}

		if (process.platform != 'linux' && this.disk == null) {
			throw new Error(
				'We cannot automatically detect the testbot interface, please provide it manually',
			);
		}

		this.mutex = new Mutex();
		this.signalHandler = this.teardown.bind(this);
	}

	static async flashFirmware() {
		const UNCONFIGURED_USB =
			'/dev/disk/by-id/usb-Generic_Ultra_HS-SD_MMC_000008264001-0:0';

		try {
			await fs.readlink(DEV_SD);
		} catch (_err) {
			// Flash sketch to expose the SD interface
			await retry(
				() => {
					return exec(
						'teensy_loader_cli',
						['-v', '-s', '-mmcu=mk66fx1m0', 'SDcardSwitch.ino.hex'],
						'./firmware',
					);
				},
				{ interval: 1000, max_tries: 10, throw_original: true },
			);
			// Allow for the sketch to run
			await Bluebird.delay(15000);
			await exec('udevadm', ['settle'], '.');
			await exec(
				'usbsdmux-configure',
				[await fs.realpath(UNCONFIGURED_USB), '1234'],
				'.',
			);
		} finally {
			// Flash firmata
			await retry(
				() => {
					return exec(
						'teensy_loader_cli',
						['-v', '-s', '-mmcu=mk66fx1m0', 'StandardFirmataPlus.ino.hex'],
						'./firmware',
					);
				},
				{ interval: 1000, max_tries: 10, throw_original: true },
			);

			await Bluebird.delay(1000);
		}
	}

	/**
	 * Critical Section function
	 */
	private async criticalSection(
		section: (args: IArguments) => unknown,
		args: IArguments,
	): Promise<void> {
		const release = await this.mutex.acquire();

		try {
			await Reflect.apply(section, this, args);
		} finally {
			release();
		}
	}

	/**
	 * Get dev interface of the SD card
	 */
	private getDevInterface(
		timeout: retry.Options = { max_tries: 5, interval: 5000 },
	): Bluebird<string> {
		return retry(
			() => {
				return fs.realpath(this.disk != null ? this.disk : DEV_SD);
			},
			{ ...timeout, throw_original: true },
		);
	}

	/**
	 * Send an array of bytes over the selected serial port
	 */
	private async sendCommand(
		command: number,
		settle: number = 0,
		a: number = 0,
		b: number = 0,
	): Promise<void> {
		this.board.serialWrite(HW_SERIAL5, [command, a, b]);
		await Bluebird.delay(settle);
	}

	/**
	 * Reset SD card controller
	 */
	private async resetSdCard(): Promise<void> {
		await this.sendCommand(GPIO.SD_RESET_ENABLE, 10);
		await this.sendCommand(GPIO.SD_RESET_DISABLE);
	}

	/**
	 * Connected the SD card interface to DUT
	 */
	private async switchSdToDUT(settle: number = 0): Promise<void> {
		console.log('Switching SD card to device...');
		await this.resetSdCard();
		this.board.digitalWrite(PINS.LED_PIN, this.board.LOW);
		this.board.digitalWrite(PINS.SD_MUX_SEL_PIN, this.board.LOW);

		await Bluebird.delay(settle);
	}

	/**
	 * Connected the SD card interface to the host
	 *
	 */
	private async switchSdToHost(settle: number = 0): Promise<void> {
		console.log('Switching SD card to host...');
		await this.resetSdCard();
		this.board.digitalWrite(PINS.LED_PIN, this.board.HIGH);
		this.board.digitalWrite(PINS.SD_MUX_SEL_PIN, this.board.HIGH);

		await Bluebird.delay(settle);
	}

	/**
	 * Power on DUT
	 */

	private async powerOnDUT(): Promise<void> {
		console.log('Switching testbot on...');
		await this.sendCommand(GPIO.ENABLE_VOUT_SW, 500);
	}

	/**
	 * Power off DUT
	 */
	private async powerOffDUT(): Promise<void> {
		console.log('Switching testbot off...');
		await this.sendCommand(GPIO.DISABLE_VOUT_SW, 500);
	}

	/**
	 * Flash SD card with operating system
	 */
	public async flash(stream: Stream.Readable): Promise<void> {
		await this.powerOff();

		await this.criticalSection(async () => {
			const source = new sdk.sourceDestination.StreamZipSource(
				new sdk.sourceDestination.SingleUseStreamSource(stream),
			);
			// For linux, udev will provide us with a nice id for the testbot
			const drive = await getDrive(await this.getDevInterface());

			const progressBar: { [key: string]: any } = {
				flashing: new visuals.Progress('Flashing'),
				verifying: new visuals.Progress('Validating'),
			};

			await sdk.multiWrite.pipeSourceToDestinations(
				source,
				[drive],
				(_destination, error) => {
					console.error(error);
				},
				(progress: sdk.multiWrite.MultiDestinationProgress) => {
					this.emit('progress', progress);
					progressBar[progress.type].update(progress);
				},
				true,
			);
		}, arguments);
	}

	/**
	 * Turn on DUT
	 */
	public async powerOn(): Promise<void> {
		await this.criticalSection(async () => {
			await this.switchSdToDUT(5000);
			await this.powerOnDUT();

			manageHandlers(this.signalHandler, {
				register: true,
			});
		}, arguments);
	}

	/**
	 * Turn off DUT
	 */
	public async powerOff(): Promise<void> {
		await this.criticalSection(async () => {
			await this.powerOffDUT();
			await this.switchSdToHost(5000);

			manageHandlers(this.signalHandler, {
				register: false,
			});
		}, arguments);
	}

	/**
	 * Network Control
	 */
	public async network(
		configuration: Supported['configuration'],
	): Promise<void> {
		if (this.net == null) {
			throw new Error('Network not configured on this worker. Ignoring...');
		}

		if (configuration.wireless != null) {
			await this.net.addWirelessConnection(configuration.wireless);
		} else {
			await this.net.removeWirelessConnection();
		}

		if (configuration.wired != null) {
			await this.net.addWiredConnection(configuration.wired);
		} else {
			await this.net.removeWiredConnection();
		}
	}

	/**
	 * Setup testbot
	 */
	public async setup(): Promise<void> {
		await this.criticalSection(async () => {
			if (process.env.CI == null) {
				await TestBot.flashFirmware();
			}

			await new Promise((resolve, reject) => {
				this.board = new Board(DEV_TESTBOT);
				this.board.once('error', reject);
				this.board.serialConfig({
					portId: HW_SERIAL5,
					baud: BAUD_RATE,
				});
				this.board.once('ready', async () => {
					// Power managment configuration
					// We set the regulator (DAC_REG) to 5V and start the managment unit (VREG)
					await this.sendCommand(GPIO.ENABLE_FAULTRST, 1000);
					this.board.pinMode(PINS.LED_PIN, this.board.MODES.OUTPUT);
					await this.sendCommand(GPIO.WRITE_DAC_REG, 1000, 5);
					await this.sendCommand(GPIO.ENABLE_VREG, 1000);

					// SD card managment configuration
					// We enable the SD/USB multiplexers and leave them disconnected
					this.board.pinMode(PINS.SD_MUX_SEL_PIN, this.board.MODES.OUTPUT);
					this.board.digitalWrite(PINS.SD_MUX_SEL_PIN, this.board.LOW);
					this.board.pinMode(PINS.USB_MUX_SEL_PIN, this.board.MODES.OUTPUT);
					this.board.digitalWrite(PINS.USB_MUX_SEL_PIN, this.board.LOW);

					await Bluebird.delay(1000);
					console.log('Worker ready');

					resolve();
				});
			});
		}, arguments);
	}

	/**
	 * Teardown testbot
	 */
	public async teardown(): Promise<void> {
		await this.powerOff();
		this.board.serialClose(HW_SERIAL5);
	}
}

export default TestBot;
