/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { e } from '../common/publish.ts';

interface ICodesignResult {
	readonly exitCode: number;
	readonly signal: NodeJS.Signals | null;
}

async function main(): Promise<void> {
	const arch = e('VSCODE_ARCH');
	const outputDirectory = path.join('.build', 'logs', 'codesign', `win32-${arch}`);
	const logPath = path.join(outputDirectory, 'codesign.log');
	const resultPath = path.join(outputDirectory, 'result.json');
	await fs.promises.mkdir(outputDirectory, { recursive: true });
	await Promise.all([
		fs.promises.rm(logPath, { force: true }),
		fs.promises.rm(resultPath, { force: true })
	]);

	const log = fs.createWriteStream(logPath);
	const child = cp.spawn('npx.cmd', ['zx', 'build/azure-pipelines/win32/codesign.ts'], {
		windowsHide: true,
		stdio: ['ignore', 'pipe', 'pipe']
	});

	child.stdout.on('data', data => {
		process.stdout.write(data);
		log.write(data);
	});
	child.stderr.on('data', data => {
		process.stderr.write(data);
		log.write(data);
	});

	const result = await new Promise<ICodesignResult>((resolve, reject) => {
		child.on('error', reject);
		child.on('close', (exitCode, signal) => resolve({ exitCode: exitCode ?? 1, signal }));
	});
	await new Promise<void>(resolve => log.end(resolve));
	await fs.promises.writeFile(resultPath, JSON.stringify(result));
	process.exitCode = result.exitCode;
}

main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
