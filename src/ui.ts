import { XMLParser } from "fast-xml-parser";

import { AdbClient, ActionableError } from "./adb.js";
import { remainingTime, withDeadline } from "./deadline.js";

export interface ElementRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ScreenElement {
	type: string;
	text?: string;
	label?: string;
	identifier?: string;
	focused?: boolean;
	clickable?: boolean;
	password?: boolean;
	editable?: boolean;
	/** Per-dump WebView group, including descendants; not a persistent document ID. */
	webView?: number;
	rect: ElementRect;
}

export interface ElementSelector {
	text?: string;
	textContains?: string;
	resourceId?: string;
	contentDesc?: string;
	className?: string;
}

interface UiNode {
	node?: UiNode | UiNode[];
	class?: string;
	text?: string;
	bounds?: string;
	hint?: string;
	focused?: string;
	clickable?: string;
	checkable?: string;
	password?: string;
	editable?: string;
	"content-desc"?: string;
	"resource-id"?: string;
}

const parseBounds = (bounds: string | undefined): ElementRect => {
	const m = String(bounds).match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
	if (!m) {
		return { x: 0, y: 0, width: 0, height: 0 };
	}
	const [, left, top, right, bottom] = m.map(Number);
	return { x: left, y: top, width: right - left, height: bottom - top };
};

const collectElements = (node: UiNode, out: ScreenElement[], groups = { next: 0, count: 0 }, webView?: number, depth = 0): void => {
	if (++groups.count > 2048 || depth > 48) throw new Error("UI hierarchy limit");
	if (Object.values(node).some(v => typeof v === "string" && v.length > 8192)) throw new Error("UI field limit");
	if (node.class === "android.webkit.WebView" && webView === undefined) webView = ++groups.next;
	if (node.node) {
		const children = Array.isArray(node.node) ? node.node : [node.node];
		for (const child of children) {
			collectElements(child, out, groups, webView, depth + 1);
		}
	}

	const editable = node.editable === "true" || /(?:^|\.)EditText$/.test(node.class || "");
	const interesting = node.text || node["content-desc"] || node.hint || node["resource-id"]
		|| node.checkable === "true" || editable || node.focused === "true" || node.password === "true"
		|| node.class === "android.webkit.WebView";
	if (!interesting) {
		return;
	}

	const rect = parseBounds(node.bounds);
	if (rect.width <= 0 || rect.height <= 0) {
		return;
	}

	const element: ScreenElement = {
		type: node.class || "text",
		rect,
	};
	if (webView !== undefined) element.webView = webView;
	if (editable) element.editable = true;
	if (node.password === "true") {
		element.password = true;
		element.text = "[password input redacted]";
	} else if (node.text) {
		element.text = node.text;
	}
	const label = node.password === "true" ? "[password input redacted]" : node["content-desc"] || node.hint;
	if (label) {
		element.label = label;
	}
	const resourceId = node["resource-id"];
	if (resourceId) {
		element.identifier = resourceId;
	}
	if (node.focused === "true") {
		element.focused = true;
	}
	if (node.clickable === "true") {
		element.clickable = true;
	}

	out.push(element);
};

export class UiInspector {

	constructor(private adb: AdbClient, private maxDumpAttempts = 2, private dumpTimeoutMs = 8000) {
	}

	private dumpXml(deviceId: string): string {
		for (let tries = 0; tries < this.maxDumpAttempts; tries++) {
			// The device-side watchdog also kills an abandoned dump if the host ADB client exits.
			const seconds = (Math.max(1, remainingTime() - 100) / 1000).toFixed(3);
			const dump = this.adb.adb(deviceId, "exec-out", "timeout", "-s", "KILL", seconds, "uiautomator", "dump", "/dev/tty").toString();
			if (dump.includes("null root node returned by UiTestAutomationBridge")) {
				continue;
			}
			const xmlStart = dump.indexOf("<?xml");
			if (xmlStart >= 0) {
				return dump.substring(xmlStart);
			}
		}
		throw new ActionableError(
			"Failed to dump UI hierarchy. The screen may be in a secure view (password field, DRM content) -- try android_take_screenshot instead."
		);
	}

	public getElements(deviceId: string): ScreenElement[] {
		return withDeadline(this.dumpTimeoutMs, () => this.readElements(deviceId));
	}

	private readElements(deviceId: string): ScreenElement[] {
		const xml = this.dumpXml(deviceId);
		if (Buffer.byteLength(xml) > 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("UI XML limit");
		let depth = 0, nodes = 0;
		for (const tag of xml.matchAll(/<\/?[A-Za-z_][\w:.-]*\b[^>]*>/g)) {
			if (tag[0].startsWith("</")) depth--;
			else { if (++nodes > 2048) throw new Error("UI node limit"); if (!tag[0].endsWith("/>")) depth++; }
			if (depth > 48) throw new Error("UI depth limit");
		}
		const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", htmlEntities: true });
		const parsed = parser.parse(xml) as { hierarchy?: { node?: UiNode | UiNode[] } };
		const root = parsed.hierarchy?.node;
		if (!root) {
			throw new ActionableError("UI dump contained no root node; screen privacy state is unknown.");
		}
		const elements: ScreenElement[] = [];
		const groups = { next: 0, count: 0 };
		for (const node of Array.isArray(root) ? root : [root]) collectElements(node, elements, groups);
		return elements;
	}

	/** Expand a short resource id ("btn_login") to full form ("com.app:id/btn_login") using the foreground app. */
	private resolveResourceId(deviceId: string, resourceId: string): string {
		if (resourceId.includes("/") || resourceId.includes(":")) {
			return resourceId;
		}
		const pkg = this.adb.getCurrentApp(deviceId).packageName;
		if (pkg !== "unknown") {
			return `${pkg}:id/${resourceId}`;
		}
		return resourceId;
	}

	public describeSelector(selector: ElementSelector): string {
		return JSON.stringify(
			Object.fromEntries(Object.entries(selector).filter(([, v]) => v !== undefined && v !== ""))
		);
	}

	public hasAnySelector(selector: ElementSelector): boolean {
		return Boolean(
			selector.text || selector.textContains || selector.resourceId || selector.contentDesc || selector.className
		);
	}

	public findElements(deviceId: string, selector: ElementSelector): ScreenElement[] {
		const elements = this.getElements(deviceId);
		// A WebView identifier is already exact. Only expand when the raw ID is absent.
		const exactId = selector.resourceId !== undefined && elements.some(el => el.identifier === selector.resourceId);
		const resolvedId = selector.resourceId && !exactId ? this.resolveResourceId(deviceId, selector.resourceId) : selector.resourceId;

		return elements.filter(el => {
			if (selector.text !== undefined && el.text !== selector.text) {
				return false;
			}
			if (selector.textContains !== undefined) {
				if (!el.text || !el.text.toLowerCase().includes(selector.textContains.toLowerCase())) {
					return false;
				}
			}
			if (resolvedId !== undefined) {
				const matchesFull = el.identifier === resolvedId;
				const shortId = !selector.resourceId?.includes(":") && !selector.resourceId?.includes("/");
				const matchesSuffix = !exactId && shortId && (el.identifier?.endsWith(`:id/${selector.resourceId}`) ?? false);
				if (!matchesFull && !matchesSuffix) {
					return false;
				}
			}
			if (selector.contentDesc !== undefined) {
				if (!el.label || !el.label.toLowerCase().includes(selector.contentDesc.toLowerCase())) {
					return false;
				}
			}
			if (selector.className !== undefined) {
				if (el.type !== selector.className && !el.type.endsWith(`.${selector.className}`)) {
					return false;
				}
			}
			return true;
		});
	}

	public async waitForElement(
		deviceId: string,
		selector: ElementSelector,
		timeoutMs: number,
		index = 0
	): Promise<ScreenElement | null> {
		return withDeadline(timeoutMs, async () => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const matches = this.findElements(deviceId, selector);
			if (matches.length > index) {
				return matches[index];
			}
			if (Date.now() >= deadline) {
				return null;
			}
			await new Promise(resolve => setTimeout(resolve, Math.min(1000, remainingTime(), Math.max(1, deadline - Date.now()))));
			if (Date.now() >= deadline) return null;
		}
		});
	}
}

export const elementCenter = (el: ScreenElement): { x: number; y: number } => {
	return {
		x: el.rect.x + Math.floor(el.rect.width / 2),
		y: el.rect.y + Math.floor(el.rect.height / 2),
	};
};
