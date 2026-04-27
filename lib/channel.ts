export const HIGH_WATERMARK = 16_777_216; // 16 MB — pause sending above this
export const LOW_WATERMARK  =  1_048_576; //  1 MB — resume sending below this
export const QUEUE_BUDGET   =  1_048_576; //  1 MB default pre-open queue budget

export interface ChannelOptions {
	ordered?: boolean;
	maxRetransmits?: number;
	maxPacketLifeTime?: number;
	queueBudget?: number; // library-specific, not passed to RTCDataChannel
}

type Listener = (...args: any[]) => void;

export class RTCIOChannel {
	private _dc: RTCDataChannel | null = null;
	private _listeners: Map<string, Listener[]> = new Map();
	private _queue: Array<string | ArrayBuffer> = [];
	private _queueBytes = 0;
	private readonly _queueBudget: number;

	constructor(queueBudget: number = QUEUE_BUDGET) {
		this._queueBudget = queueBudget;
	}

	_attach(dc: RTCDataChannel): void {
		this._dc = dc;
		dc.binaryType = "arraybuffer";
		dc.bufferedAmountLowThreshold = LOW_WATERMARK;

		dc.onopen = () => {
			this._flush();
			this._dispatchLocal("open");
		};

		dc.onclose = () => {
			this._dc = null;
			this._queue = [];
			this._queueBytes = 0;
			this._dispatchLocal("close");
		};

		dc.onerror = (e) => {
			this._dispatchLocal("error", e);
		};

		dc.onmessage = ({ data }) => {
			if (typeof data === "string") {
				try {
					const { e, d } = JSON.parse(data);
					if (typeof e !== "string") return;
					const args: any[] = Array.isArray(d) ? d : [];
					this._dispatchLocal(e, ...args);
				} catch {
					this._dispatchLocal(
						"error",
						new Error("RTCIOChannel: invalid JSON envelope"),
					);
				}
			} else {
				this._dispatchLocal("data", data);
			}
		};

		dc.onbufferedamountlow = () => {
			this._flush();
			this._dispatchLocal("drain");
		};

		// Already open by the time _attach is called (rare but possible)
		if (dc.readyState === "open") {
			this._flush();
		}
	}

	_isAttached(): boolean {
		return this._dc !== null;
	}

	emit(eventName: string, ...args: any[]): void {
		if (typeof args[args.length - 1] === "function") {
			console.warn(
				`[rtc-io] RTCIOChannel.emit('${eventName}'): ack callbacks are not supported — dropping callback`,
			);
			args = args.slice(0, -1);
		}
		const message = JSON.stringify({ e: eventName, d: args });
		this._write(message);
	}

	send(data: ArrayBuffer | string): boolean {
		return this._write(data);
	}

	on(event: string, handler: Listener): this {
		let list = this._listeners.get(event);
		if (!list) {
			list = [];
			this._listeners.set(event, list);
		}
		list.push(handler);
		return this;
	}

	off(event: string, handler: Listener): this {
		const list = this._listeners.get(event);
		if (!list) return this;
		const idx = list.indexOf(handler);
		if (idx !== -1) list.splice(idx, 1);
		return this;
	}

	once(event: string, handler: Listener): this {
		const wrapper: Listener = (...args: any[]) => {
			this.off(event, wrapper);
			handler(...args);
		};
		return this.on(event, wrapper);
	}

	close(): void {
		const dc = this._dc;
		if (dc && dc.readyState !== "closed" && dc.readyState !== "closing") {
			dc.close();
		}
		this._queue = [];
		this._queueBytes = 0;
	}

	get readyState(): RTCDataChannelState {
		return this._dc?.readyState ?? "connecting";
	}

	get bufferedAmount(): number {
		return this._dc?.bufferedAmount ?? 0;
	}

	_dispatchLocal(event: string, ...args: any[]): void {
		const list = this._listeners.get(event);
		if (!list) return;
		// snapshot to allow safe off/once during dispatch
		list.slice().forEach((h) => {
			try {
				h(...args);
			} catch (e) {
				console.error(`[rtc-io] RTCIOChannel listener [${event}]`, e);
			}
		});
	}

	private _write(data: string | ArrayBuffer): boolean {
		const dc = this._dc;
		if (
			dc &&
			dc.readyState === "open" &&
			dc.bufferedAmount < HIGH_WATERMARK &&
			this._queue.length === 0
		) {
			try {
				dc.send(data as any);
				return true;
			} catch (e) {
				this._dispatchLocal("error", e);
				return false;
			}
		}
		return this._enqueue(data);
	}

	private _enqueue(data: string | ArrayBuffer): boolean {
		const size =
			typeof data === "string" ? data.length * 2 : data.byteLength;
		if (this._queueBytes + size > this._queueBudget) {
			this._dispatchLocal(
				"error",
				new Error(
					"RTCIOChannel: queue budget exceeded — wait for 'drain' before sending more",
				),
			);
			return false;
		}
		this._queue.push(data);
		this._queueBytes += size;
		return false;
	}

	private _flush(): void {
		while (this._queue.length > 0) {
			const dc = this._dc;
			if (!dc || dc.readyState !== "open") break;
			if (dc.bufferedAmount >= HIGH_WATERMARK) break;

			const item = this._queue.shift()!;
			const size =
				typeof item === "string"
					? item.length * 2
					: (item as ArrayBuffer).byteLength;
			this._queueBytes -= size;

			try {
				dc.send(item as any);
			} catch (e) {
				this._dispatchLocal("error", e);
				break;
			}
		}
	}
}
