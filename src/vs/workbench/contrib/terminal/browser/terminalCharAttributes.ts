/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { XTermAttributes } from 'vs/workbench/contrib/terminal/browser/xterm-private';

/**
 * Internals mirrored from xterm.js.
 */

export function updateCharAttributes(attr: AttributeData, rawParams: (number | number[])[]): void {
	const params = new MiniParams(rawParams);

	// Optimize a single SGR0.
	if (params.length === 1 && params.params[0] === 0) {
		attr.fg = DEFAULT_ATTR_DATA.fg;
		attr.bg = DEFAULT_ATTR_DATA.bg;
		return;
	}

	const l = params.length;
	let p;

	for (let i = 0; i < l; i++) {
		p = params.n(i);
		if (p >= 30 && p <= 37) {
			// fg color 8
			attr.fg &= ~(Attributes.CM_MASK | Attributes.PCOLOR_MASK);
			attr.fg |= Attributes.CM_P16 | (p - 30);
		} else if (p >= 40 && p <= 47) {
			// bg color 8
			attr.bg &= ~(Attributes.CM_MASK | Attributes.PCOLOR_MASK);
			attr.bg |= Attributes.CM_P16 | (p - 40);
		} else if (p >= 90 && p <= 97) {
			// fg color 16
			attr.fg &= ~(Attributes.CM_MASK | Attributes.PCOLOR_MASK);
			attr.fg |= Attributes.CM_P16 | (p - 90) | 8;
		} else if (p >= 100 && p <= 107) {
			// bg color 16
			attr.bg &= ~(Attributes.CM_MASK | Attributes.PCOLOR_MASK);
			attr.bg |= Attributes.CM_P16 | (p - 100) | 8;
		} else if (p === 0) {
			// default
			attr.fg = DEFAULT_ATTR_DATA.fg;
			attr.bg = DEFAULT_ATTR_DATA.bg;
		} else if (p === 1) {
			// bold text
			attr.fg |= FgFlags.BOLD;
		} else if (p === 3) {
			// italic text
			attr.bg |= BgFlags.ITALIC;
		} else if (p === 4) {
			// underlined text
			attr.fg |= FgFlags.UNDERLINE;
			processUnderline(params.hasSubParams(i) ? params.getSubParams(i)![0] : UnderlineStyle.SINGLE, attr);
		} else if (p === 5) {
			// blink
			attr.fg |= FgFlags.BLINK;
		} else if (p === 7) {
			// inverse and positive
			// test with: echo -e '\e[31m\e[42mhello\e[7mworld\e[27mhi\e[m'
			attr.fg |= FgFlags.INVERSE;
		} else if (p === 8) {
			// invisible
			attr.fg |= FgFlags.INVISIBLE;
		} else if (p === 2) {
			// dimmed text
			attr.bg |= BgFlags.DIM;
		} else if (p === 21) {
			// double underline
			processUnderline(UnderlineStyle.DOUBLE, attr);
		} else if (p === 22) {
			// not bold nor faint
			attr.fg &= ~FgFlags.BOLD;
			attr.bg &= ~BgFlags.DIM;
		} else if (p === 23) {
			// not italic
			attr.bg &= ~BgFlags.ITALIC;
		} else if (p === 24) {
			// not underlined
			attr.fg &= ~FgFlags.UNDERLINE;
		} else if (p === 25) {
			// not blink
			attr.fg &= ~FgFlags.BLINK;
		} else if (p === 27) {
			// not inverse
			attr.fg &= ~FgFlags.INVERSE;
		} else if (p === 28) {
			// not invisible
			attr.fg &= ~FgFlags.INVISIBLE;
		} else if (p === 39) {
			// reset fg
			attr.fg &= ~(Attributes.CM_MASK | Attributes.RGB_MASK);
			attr.fg |= DEFAULT_ATTR_DATA.fg & (Attributes.PCOLOR_MASK | Attributes.RGB_MASK);
		} else if (p === 49) {
			// reset bg
			attr.bg &= ~(Attributes.CM_MASK | Attributes.RGB_MASK);
			attr.bg |= DEFAULT_ATTR_DATA.bg & (Attributes.PCOLOR_MASK | Attributes.RGB_MASK);
		} else if (p === 38 || p === 48 || p === 58) {
			// fg color 256 and RGB
			i += extractColor(params, i, attr);
		} else if (p === 59) {
			attr.extended = attr.extended.clone();
			attr.extended.underlineColor = -1;
			attr.updateExtended();
		} else if (p === 100) { // FIXME: dead branch, p=100 already handled above!
			// reset fg/bg
			attr.fg &= ~(Attributes.CM_MASK | Attributes.RGB_MASK);
			attr.fg |= DEFAULT_ATTR_DATA.fg & (Attributes.PCOLOR_MASK | Attributes.RGB_MASK);
			attr.bg &= ~(Attributes.CM_MASK | Attributes.RGB_MASK);
			attr.bg |= DEFAULT_ATTR_DATA.bg & (Attributes.PCOLOR_MASK | Attributes.RGB_MASK);
		}
	}
}

class MiniParams {
	public readonly length = this.params.length;

	constructor(public readonly params: (number | number[])[]) { }

	public n(index: number) {
		const p = this.params[index];
		return typeof p === 'number' ? p : p[0];
	}

	public hasSubParams(index: number) {
		return typeof this.params[index] !== 'number';
	}

	public getSubParams(index: number) {
		const p = this.params[index];
		return typeof p === 'number' ? undefined : p.slice(1);
	}
}

function extractColor(params: MiniParams, pos: number, attr: AttributeData): number {
	// normalize params
	// meaning: [target, CM, ign, val, val, val]
	// RGB    : [ 38/48,  2, ign,   r,   g,   b]
	// P256   : [ 38/48,  5, ign,   v, ign, ign]
	const accu = [0, 0, -1, 0, 0, 0];

	// alignment placeholder for non color space sequences
	let cSpace = 0;

	// return advance we took in params
	let advance = 0;

	do {
		accu[advance + cSpace] = params.n(pos + advance);
		if (params.hasSubParams(pos + advance)) {
			const subparams = params.getSubParams(pos + advance)!;
			let i = 0;
			do {
				if (accu[1] === 5) {
					cSpace = 1;
				}
				accu[advance + i + 1 + cSpace] = subparams[i];
			} while (++i < subparams.length && i + advance + 1 + cSpace < accu.length);
			break;
		}
		// exit early if can decide color mode with semicolons
		if ((accu[1] === 5 && advance + cSpace >= 2)
			|| (accu[1] === 2 && advance + cSpace >= 5)) {
			break;
		}
		// offset colorSpace slot for semicolon mode
		if (accu[1]) {
			cSpace = 1;
		}
	} while (++advance + pos < params.length && advance + cSpace < accu.length);

	// set default values to 0
	for (let i = 2; i < accu.length; ++i) {
		if (accu[i] === -1) {
			accu[i] = 0;
		}
	}

	// apply colors
	switch (accu[0]) {
		case 38:
			attr.fg = updateAttrColor(attr.fg, accu[1], accu[3], accu[4], accu[5]);
			break;
		case 48:
			attr.bg = updateAttrColor(attr.bg, accu[1], accu[3], accu[4], accu[5]);
			break;
	}

	return advance;
}

function updateAttrColor(color: number, mode: number, c1: number, c2: number, c3: number): number {
	if (mode === 2) {
		color |= Attributes.CM_RGB;
		color &= ~Attributes.RGB_MASK;
		color |= AttributeData.fromColorRGB([c1, c2, c3]);
	} else if (mode === 5) {
		color &= ~(Attributes.CM_MASK | Attributes.PCOLOR_MASK);
		color |= Attributes.CM_P256 | (c1 & 0xff);
	}
	return color;
}

function processUnderline(style: number, attr: AttributeData): void {
	// treat extended attrs as immutable, thus always clone from old one
	// this is needed since the buffer only holds references to it
	attr.extended = attr.extended.clone();

	// default to 1 == single underline
	if (!~style || style > 5) {
		style = 1;
	}
	attr.extended.underlineStyle = style;
	attr.fg |= FgFlags.UNDERLINE;

	// 0 deactivates underline
	if (style === 0) {
		attr.fg &= ~FgFlags.UNDERLINE;
	}

	// update HAS_EXTENDED in BG
	attr.updateExtended();
}

class AttributeData implements XTermAttributes {
	public clone() {
		const newObj = new AttributeData();
		newObj.fg = this.fg;
		newObj.bg = this.bg;
		newObj.extended = this.extended.clone();
		return newObj;
	}

	public static fromColorRGB(value: [r: number, b: number, g: number]): number {
		return (value[0] & 255) << Attributes.RED_SHIFT | (value[1] & 255) << Attributes.GREEN_SHIFT | value[2] & 255;
	}

	// data
	public fg = 0;
	public bg = 0;
	public extended = new ExtendedAttrs();

	// flags
	public isInverse(): number { return this.fg & FgFlags.INVERSE; }
	public isBold(): number { return this.fg & FgFlags.BOLD; }
	public isUnderline(): number { return this.fg & FgFlags.UNDERLINE; }
	public isBlink(): number { return this.fg & FgFlags.BLINK; }
	public isInvisible(): number { return this.fg & FgFlags.INVISIBLE; }
	public isItalic(): number { return this.bg & BgFlags.ITALIC; }
	public isDim(): number { return this.bg & BgFlags.DIM; }

	// color modes
	public getFgColorMode(): number { return this.fg & Attributes.CM_MASK; }
	public getBgColorMode(): number { return this.bg & Attributes.CM_MASK; }
	public isFgRGB(): boolean { return (this.fg & Attributes.CM_MASK) === Attributes.CM_RGB; }
	public isBgRGB(): boolean { return (this.bg & Attributes.CM_MASK) === Attributes.CM_RGB; }
	public isFgPalette(): boolean { return (this.fg & Attributes.CM_MASK) === Attributes.CM_P16 || (this.fg & Attributes.CM_MASK) === Attributes.CM_P256; }
	public isBgPalette(): boolean { return (this.bg & Attributes.CM_MASK) === Attributes.CM_P16 || (this.bg & Attributes.CM_MASK) === Attributes.CM_P256; }
	public isFgDefault(): boolean { return (this.fg & Attributes.CM_MASK) === 0; }
	public isBgDefault(): boolean { return (this.bg & Attributes.CM_MASK) === 0; }
	public isAttributeDefault(): boolean { return this.fg === 0 && this.bg === 0; }

	// colors
	public getFgColor(): number {
		switch (this.fg & Attributes.CM_MASK) {
			case Attributes.CM_P16:
			case Attributes.CM_P256: return this.fg & Attributes.PCOLOR_MASK;
			case Attributes.CM_RGB: return this.fg & Attributes.RGB_MASK;
			default: return -1;  // CM_DEFAULT defaults to -1
		}
	}
	public getBgColor(): number {
		switch (this.bg & Attributes.CM_MASK) {
			case Attributes.CM_P16:
			case Attributes.CM_P256: return this.bg & Attributes.PCOLOR_MASK;
			case Attributes.CM_RGB: return this.bg & Attributes.RGB_MASK;
			default: return -1;  // CM_DEFAULT defaults to -1
		}
	}
	// extended attrs
	public hasExtendedAttrs(): number {
		return this.bg & BgFlags.HAS_EXTENDED;
	}
	public updateExtended(): void {
		if (this.extended.isEmpty()) {
			this.bg &= ~BgFlags.HAS_EXTENDED;
		} else {
			this.bg |= BgFlags.HAS_EXTENDED;
		}
	}
	public getUnderlineColor(): number {
		if ((this.bg & BgFlags.HAS_EXTENDED) && ~this.extended.underlineColor) {
			switch (this.extended.underlineColor & Attributes.CM_MASK) {
				case Attributes.CM_P16:
				case Attributes.CM_P256: return this.extended.underlineColor & Attributes.PCOLOR_MASK;
				case Attributes.CM_RGB: return this.extended.underlineColor & Attributes.RGB_MASK;
				default: return this.getFgColor();
			}
		}
		return this.getFgColor();
	}
	public getUnderlineColorMode(): number {
		return (this.bg & BgFlags.HAS_EXTENDED) && ~this.extended.underlineColor
			? this.extended.underlineColor & Attributes.CM_MASK
			: this.getFgColorMode();
	}
	public isUnderlineColorRGB(): boolean {
		return (this.bg & BgFlags.HAS_EXTENDED) && ~this.extended.underlineColor
			? (this.extended.underlineColor & Attributes.CM_MASK) === Attributes.CM_RGB
			: this.isFgRGB();
	}
	public isUnderlineColorPalette(): boolean {
		return (this.bg & BgFlags.HAS_EXTENDED) && ~this.extended.underlineColor
			? (this.extended.underlineColor & Attributes.CM_MASK) === Attributes.CM_P16
			|| (this.extended.underlineColor & Attributes.CM_MASK) === Attributes.CM_P256
			: this.isFgPalette();
	}
	public isUnderlineColorDefault(): boolean {
		return (this.bg & BgFlags.HAS_EXTENDED) && ~this.extended.underlineColor
			? (this.extended.underlineColor & Attributes.CM_MASK) === 0
			: this.isFgDefault();
	}
	public getUnderlineStyle(): UnderlineStyle {
		return this.fg & FgFlags.UNDERLINE
			? (this.bg & BgFlags.HAS_EXTENDED ? this.extended.underlineStyle : UnderlineStyle.SINGLE)
			: UnderlineStyle.NONE;
	}
}


/**
 * Extended attributes for a cell.
 * Holds information about different underline styles and color.
 */
export class ExtendedAttrs {
	constructor(
		// underline style, NONE is empty
		public underlineStyle: UnderlineStyle = UnderlineStyle.NONE,
		// underline color, -1 is empty (same as FG)
		public underlineColor: number = -1
	) { }

	public clone() {
		return new ExtendedAttrs(this.underlineStyle, this.underlineColor);
	}

	/**
	 * Convenient method to indicate whether the object holds no additional information,
	 * that needs to be persistant in the buffer.
	 */
	public isEmpty(): boolean {
		return this.underlineStyle === UnderlineStyle.NONE;
	}
}


export const enum Attributes {
	/**
	 * bit 1..8     blue in RGB, color in P256 and P16
	 */
	BLUE_MASK = 0xFF,
	BLUE_SHIFT = 0,
	PCOLOR_MASK = 0xFF,
	PCOLOR_SHIFT = 0,

	/**
	 * bit 9..16    green in RGB
	 */
	GREEN_MASK = 0xFF00,
	GREEN_SHIFT = 8,

	/**
	 * bit 17..24   red in RGB
	 */
	RED_MASK = 0xFF0000,
	RED_SHIFT = 16,

	/**
	 * bit 25..26   color mode: DEFAULT (0) | P16 (1) | P256 (2) | RGB (3)
	 */
	CM_MASK = 0x3000000,
	CM_DEFAULT = 0,
	CM_P16 = 0x1000000,
	CM_P256 = 0x2000000,
	CM_RGB = 0x3000000,

	/**
	 * bit 1..24  RGB room
	 */
	RGB_MASK = 0xFFFFFF
}

const enum FgFlags {
	/**
	 * bit 27..31 (32th bit unused)
	 */
	INVERSE = 0x4000000,
	BOLD = 0x8000000,
	UNDERLINE = 0x10000000,
	BLINK = 0x20000000,
	INVISIBLE = 0x40000000
}

const enum BgFlags {
	/**
	 * bit 27..32 (upper 3 unused)
	 */
	ITALIC = 0x4000000,
	DIM = 0x8000000,
	HAS_EXTENDED = 0x10000000
}

const enum UnderlineStyle {
	NONE = 0,
	SINGLE = 1,
	DOUBLE = 2,
	CURLY = 3,
	DOTTED = 4,
	DASHED = 5
}


export const DEFAULT_ATTR_DATA = Object.freeze(new AttributeData());
