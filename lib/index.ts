import * as bodyParser from 'body-parser';
import { spawn, ChildProcess } from 'child_process';
import { multiWrite } from 'etcher-sdk';
import * as express from 'express';
import * as http from 'http';
import { merge } from 'lodash';

import { getIpFromIface, getStoragePath } from './helpers';
import TestBot from './workers/testbot';
import Qemu from './workers/qemu';
import PortForward from './workers/forward';

const PERSISTANT_STORAGE_LABEL = 'STORAGE';

type workers = { testbot: typeof TestBot; qemu: typeof Qemu };
const workersDict: { [key in keyof workers]: workers[key] } = {
	testbot: TestBot,
	qemu: Qemu,
};

async function setup(): Promise<express.Application> {
	/**
	 * Server context
	 */
	const jsonParser = bodyParser.json();
	const app = express();
	const httpServer = http.createServer(app);

	let worker: Leviathan.Worker;
	let forwarder = new PortForward();
	let proxy: { proc?: ChildProcess; kill: () => void } = {
		kill: function() {
			if (proxy.proc != null) {
				proxy.proc.kill();
			}
		},
	};

	/**
	 * Select a worker route
	 */
	app.post(
		'/select',
		jsonParser,
		async (
			req: express.Request,
			res: express.Response,
			next: express.NextFunction,
		) => {
			try {
				if (worker != null) {
					await worker.teardown();
				}

				if (req.body.type != null && req.body.type in workersDict) {
					worker = new workersDict[req.body.type as keyof workers](
						merge(
							{
								worker: {
									disk: await getStoragePath(PERSISTANT_STORAGE_LABEL),
								},
							},
							req.body.options,
						),
					);
					await worker.setup();
					res.send('OK');
				} else {
					res.status(500).send('Invalid worker type');
				}
			} catch (err) {
				next(err);
			}
		},
	);

	/**
	 * Setup DeviceUnderTest routes
	 */
	app.post(
		'/dut/on',
		async (
			_req: express.Request,
			res: express.Response,
			next: express.NextFunction,
		) => {
			try {
				if (worker == null) {
					throw new Error(
						'No worker has been selected, please call /select first',
					);
				}
				await worker.powerOn();
				res.send('OK');
			} catch (err) {
				next(err);
			}
		},
	);
	app.post(
		'/dut/off',
		async (
			_req: express.Request,
			res: express.Response,
			next: express.NextFunction,
		) => {
			try {
				if (worker == null) {
					throw new Error(
						'No worker has been selected, please call /select first',
					);
				}
				await worker.powerOff();
				res.send('OK');
			} catch (err) {
				next(err);
			}
		},
	);
	app.post(
		'/dut/network',
		jsonParser,
		async (
			req: express.Request,
			res: express.Response,
			next: express.NextFunction,
		) => {
			try {
				if (worker == null) {
					throw new Error(
						'No worker has been selected, please call /select first',
					);
				}

				await worker.network(req.body);
				res.send('OK');
			} catch (err) {
				next(err);
			}
		},
	);
	app.post(
		'/dut/tunnel',
		jsonParser,
		async (
			req: express.Request,
			res: express.Response,
			next: express.NextFunction,
		) => {
			try {
				if (worker == null) {
					throw new Error(
						'No worker has been selected, please call /select first',
					);
				}

				if (req.body.from == null && req.body.to == null) {
					forwarder.destroy();
					res.send('OK');
				} else {
					if (req.body.from == null || req.body.to == null) {
						throw new Error('Require port and address for tunnel setting');
					}

					await forwarder.forward(req.body.from, req.body.to);

					res.send('OK');
				}
			} catch (err) {
				next(err);
			}
		},
	);
	app.post(
		'/proxy',
		jsonParser,
		async (
			req: express.Request,
			res: express.Response,
			next: express.NextFunction,
		) => {
			// For simplicity we will delegate to glider for now
			try {
				if (worker == null) {
					throw new Error(
						'No worker has been selected, please call /select first',
					);
				}

				proxy.kill();
				if (req.body.port != null) {
					let ip;

					if (worker.state.network.wired != null) {
						ip = {
							ip: getIpFromIface(worker.state.network.wired),
						};
					}

					if (worker.state.network.wireless != null) {
						ip = {
							ip: getIpFromIface(worker.state.network.wireless),
						};
					}

					if (ip == null) {
						throw new Error('DUT network could not be found');
					}

					process.off('exit', proxy.kill);
					proxy.proc = spawn('glider', ['-listen', req.body.port]);
					process.on('exit', proxy.kill);

					res.send(ip);
				} else {
					res.send('OK');
				}
			} catch (err) {
				next(err);
			}
		},
	);
	app.post(
		'/teardown',
		async (
			_req: express.Request,
			res: express.Response,
			next: express.NextFunction,
		) => {
			try {
				if (worker != null) {
					await worker.teardown();
				}
				forwarder.destroy();
				proxy.kill();
				res.send('OK');
			} catch (e) {
				next(e);
			}
		},
	);
	app.use(function(
		err: Error,
		_req: express.Request,
		res: express.Response,
		_next: express.NextFunction,
	) {
		res.status(500).send(err.message);
	});
	app.post(
		'/dut/flash',
		async (req: express.Request, res: express.Response) => {
			if (worker == null) {
				throw new Error(
					'No worker has been selected, please call /select first',
				);
			}

			function onProgress(progress: multiWrite.MultiDestinationProgress): void {
				res.write(`progress: ${JSON.stringify(progress)}`);
			}

			res.writeHead(202, {
				'Content-Type': 'text/event-stream',
				Connection: 'keep-alive',
			});

			const timer = setInterval(() => {
				res.write('status: pending');
			}, httpServer.keepAliveTimeout);

			try {
				worker.on('progress', onProgress);

				await worker.flash(req);
			} catch (e) {
				res.write(`error: ${e.message}`);
			} finally {
				worker.removeListener('progress', onProgress);
				res.write('status: done');
				res.end();
				clearInterval(timer);
			}
		},
	);

	return app;
}

export default setup;
