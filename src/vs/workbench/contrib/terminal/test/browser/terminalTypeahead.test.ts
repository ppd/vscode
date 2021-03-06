/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Terminal } from 'xterm';
import { SinonStub, stub, useFakeTimers } from 'sinon';
import { Emitter } from 'vs/base/common/event';
import { IPrediction, PredictionStats, TypeAheadAddon } from 'vs/workbench/contrib/terminal/browser/terminalTypeAheadAddon';
import { IBeforeProcessDataEvent, ITerminalConfiguration, ITerminalProcessManager } from 'vs/workbench/contrib/terminal/common/terminal';
import { TerminalConfigHelper } from 'vs/workbench/contrib/terminal/browser/terminalConfigHelper';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';

const CSI = `\x1b[`;

suite('Workbench - Terminal Typeahead', () => {
	suite('PredictionStats', () => {
		let stats: PredictionStats;
		const add = new Emitter<IPrediction>();
		const succeed = new Emitter<IPrediction>();
		const fail = new Emitter<IPrediction>();

		setup(() => {
			stats = new PredictionStats({
				onPredictionAdded: add.event,
				onPredictionSucceeded: succeed.event,
				onPredictionFailed: fail.event,
			} as any);
		});

		test('creates sane data', () => {
			const stubs = createPredictionStubs(5);
			const clock = useFakeTimers();
			try {
				for (const s of stubs) { add.fire(s); }

				for (let i = 0; i < stubs.length; i++) {
					clock.tick(100);
					(i % 2 ? fail : succeed).fire(stubs[i]);
				}

				assert.strictEqual(stats.accuracy, 3 / 5);
				assert.strictEqual(stats.sampleSize, 5);
				assert.deepStrictEqual(stats.latency, {
					count: 3,
					min: 100,
					max: 500,
					median: 300
				});
			} finally {
				clock.restore();
			}
		});

		test('circular buffer', () => {
			const bufferSize = 24;
			const stubs = createPredictionStubs(bufferSize * 2);

			for (const s of stubs.slice(0, bufferSize)) { add.fire(s); succeed.fire(s); }
			assert.strictEqual(stats.accuracy, 1);

			for (const s of stubs.slice(bufferSize, bufferSize * 3 / 2)) { add.fire(s); fail.fire(s); }
			assert.strictEqual(stats.accuracy, 0.5);

			for (const s of stubs.slice(bufferSize * 3 / 2)) { add.fire(s); fail.fire(s); }
			assert.strictEqual(stats.accuracy, 0);
		});
	});

	suite('timeline', () => {
		const onBeforeProcessData = new Emitter<IBeforeProcessDataEvent>();
		const onConfigChanged = new Emitter<void>();
		let publicLog: SinonStub;
		let config: ITerminalConfiguration;
		let addon: TypeAheadAddon;

		const predictedHelloo = [
			`${CSI}?25l`, // hide cursor
			`${CSI}2;7H`, // move cursor cursor
			'o', // new character
			`${CSI}2;8H`, // place cursor back at end of line
			`${CSI}?25h`, // show cursor
		].join('');

		const expectProcessed = (input: string, output: string) => {
			const evt = { data: input };
			onBeforeProcessData.fire(evt);
			assert.strictEqual(JSON.stringify(evt.data), JSON.stringify(output));
		};

		setup(() => {
			config = upcastPartial<ITerminalConfiguration>({
				typeaheadStyle: 'italic',
				typeaheadThreshold: 0
			});
			publicLog = stub();
			addon = new TypeAheadAddon(
				upcastPartial<ITerminalProcessManager>({ onBeforeProcessData: onBeforeProcessData.event }),
				upcastPartial<TerminalConfigHelper>({ config, onConfigChanged: onConfigChanged.event }),
				upcastPartial<ITelemetryService>({ publicLog })
			);
		});

		teardown(() => {
			addon.dispose();
		});

		test('predicts a single character', () => {
			const t = createMockTerminal('hello|');
			addon.activate(t.terminal);
			t.onData('o');
			t.expectWritten(`${CSI}3mo`);
		});

		test('validates character prediction', () => {
			const t = createMockTerminal('hello|');
			addon.activate(t.terminal);
			t.onData('o');
			expectProcessed('o', predictedHelloo);
			assert.strictEqual(addon.stats?.accuracy, 1);
		});

		test('rolls back character prediction', () => {
			const t = createMockTerminal('hello|');
			addon.activate(t.terminal);
			t.onData('o');

			expectProcessed('q', [
				`${CSI}?25l`, // hide cursor
				`${CSI}2;7H`, // move cursor cursor
				`${CSI}X`, // delete character
				'q', // new character
				`${CSI}?25h`, // show cursor
			].join(''));
			assert.strictEqual(addon.stats?.accuracy, 0);
		});

		test('validates against and applies graphics mode on predicted', () => {
			const t = createMockTerminal('hello|');
			addon.activate(t.terminal);
			t.onData('o');
			expectProcessed(`${CSI}4mo`, [
				`${CSI}?25l`, // hide cursor
				`${CSI}2;7H`, // move cursor cursor
				`${CSI}4m`, // PTY's style
				'o', // new character
				`${CSI}2;8H`, // place cursor back at end of line
				`${CSI}?25h`, // show cursor
			].join(''));
			assert.strictEqual(addon.stats?.accuracy, 1);
		});

		test('ignores cursor hides or shows', () => {
			const t = createMockTerminal('hello|');
			addon.activate(t.terminal);
			t.onData('o');
			expectProcessed(`${CSI}?25lo${CSI}?25h`, [
				`${CSI}?25l`, // hide cursor from PTY
				`${CSI}?25l`, // hide cursor
				`${CSI}2;7H`, // move cursor cursor
				'o', // new character
				`${CSI}?25h`, // show cursor from PTY
				`${CSI}2;8H`, // place cursor back at end of line
				`${CSI}?25h`, // show cursor
			].join(''));
			assert.strictEqual(addon.stats?.accuracy, 1);
		});

		test('matches backspace at EOL (bash style)', () => {
			const t = createMockTerminal('hello|');
			addon.activate(t.terminal);
			t.onData('\x7F');
			expectProcessed(`\b${CSI}K`, `\b${CSI}K`);
			assert.strictEqual(addon.stats?.accuracy, 1);
		});

		test('matches backspace at EOL (zsh style)', () => {
			const t = createMockTerminal('hello|');
			addon.activate(t.terminal);
			t.onData('\x7F');
			expectProcessed('\b \b', '\b \b');
			assert.strictEqual(addon.stats?.accuracy, 1);
		});

		test('gradually matches backspace', () => {
			const t = createMockTerminal('hello|');
			addon.activate(t.terminal);
			t.onData('\x7F');
			expectProcessed('\b', '');
			expectProcessed(' \b', '\b \b');
			assert.strictEqual(addon.stats?.accuracy, 1);
		});

		test('waits for validation before deleting to left of cursor', () => {
			const t = createMockTerminal('hello|');
			addon.activate(t.terminal);

			// initially should not backspace (until the server confirms it)
			t.onData('\x7F');
			t.expectWritten('');
			expectProcessed('\b \b', '\b \b');
			t.cursor.x--;

			// enter input on the column...
			t.onData('o');
			onBeforeProcessData.fire({ data: 'o' });
			t.cursor.x++;
			t.clearWritten();

			// now that the column is 'unlocked', we should be able to predict backspace on it
			t.onData('\x7F');
			t.expectWritten(`${CSI}2;6H${CSI}X`);
		});

		test('avoids predicting password input', () => {
			const t = createMockTerminal('hello|');
			addon.activate(t.terminal);
			expectProcessed('Your password: ', 'Your password: ');

			t.onData('mellon\r\n');
			t.expectWritten('');
			expectProcessed('\r\n', '\r\n');

			t.onData('o'); // back to normal mode
			t.expectWritten(`${CSI}3mo`);
		});
	});
});

function upcastPartial<T>(v: Partial<T>): T {
	return v as T;
}

function createPredictionStubs(n: number) {
	return new Array(n).fill(0).map(stubPrediction);
}

function stubPrediction(): IPrediction {
	return {
		apply: () => '',
		rollback: () => '',
		matches: () => 0,
		rollForwards: () => '',
	};
}

function createMockTerminal(...lines: string[]) {
	const written: string[] = [];
	const cursor = { y: 1, x: 1 };
	const onData = new Emitter<string>();

	for (let y = 0; y < lines.length; y++) {
		const line = lines[y];
		if (line.includes('|')) {
			cursor.y = y + 1;
			cursor.x = line.indexOf('|') + 1;
			lines[y] = line.replace('|', '');
			break;
		}
	}

	return {
		written,
		cursor,
		expectWritten: (s: string) => {
			assert.strictEqual(JSON.stringify(written.join('')), JSON.stringify(s));
			written.splice(0, written.length);
		},
		clearWritten: () => written.splice(0, written.length),
		onData: (s: string) => onData.fire(s),
		terminal: {
			cols: 80,
			rows: 5,
			onResize: new Emitter<void>().event,
			onData: onData.event,
			write(line: string) {
				written.push(line);
			},
			buffer: {
				active: {
					type: 'normal',
					baseY: 0,
					get cursorY() { return cursor.y; },
					get cursorX() { return cursor.x; },
					getLine(y: number) {
						const s = lines[y - 1] || '';
						return {
							length: s.length,
							getCell: (x: number) => mockCell(s[x - 1] || ''),
						};
					},
				}
			}
		} as unknown as Terminal
	};
}

function mockCell(char: string) {
	return new Proxy({}, {
		get(_, prop) {
			switch (prop) {
				case 'getWidth':
					return () => 1;
				case 'getChars':
					return () => char;
				case 'getCode':
					return () => char.charCodeAt(0) || 0;
				default:
					return String(prop).startsWith('is') ? (() => false) : (() => 0);
			}
		},
	});
}
