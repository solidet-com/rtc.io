import { RTCIOChannel } from "./channel";

type Listener = (...args: any[]) => void;

export class RTCIOBroadcastChannel {
	private _peers: Map<string, RTCIOChannel> = new Map();
	private _globalListeners: Map<string, Listener[]> = new Map();
	private _closed = false;

	_addPeer(peerId: string, channel: RTCIOChannel): void {
		if (this._closed) return;
		// Replace any existing entry for this peer (e.g. ICE restart re-attached)
		this._peers.set(peerId, channel);

		this._globalListeners.forEach((handlers, event) => {
			handlers.forEach((h) => channel.on(event, h));
		});

		channel.on("drain", () => this._dispatch("drain"));
		channel.on("error", (e: any) => this._dispatch("error", e));
		channel.on("close", () => this._removePeer(peerId));
	}

	_removePeer(peerId: string): void {
		if (!this._peers.has(peerId)) return;
		this._peers.delete(peerId);
		this._dispatch("peer-left", peerId);
		if (this._peers.size === 0 && !this._closed) {
			this._dispatch("close");
		}
	}

	emit(eventName: string, payload?: any): void {
		this._peers.forEach((ch) => ch.emit(eventName, payload));
	}

	send(data: ArrayBuffer | string): boolean {
		let allOk = true;
		this._peers.forEach((ch) => {
			if (!ch.send(data)) allOk = false;
		});
		return allOk;
	}

	on(event: string, handler: Listener): this {
		let list = this._globalListeners.get(event);
		if (!list) {
			list = [];
			this._globalListeners.set(event, list);
		}
		list.push(handler);
		this._peers.forEach((ch) => ch.on(event, handler));
		return this;
	}

	off(event: string, handler: Listener): this {
		const list = this._globalListeners.get(event);
		if (list) {
			const idx = list.indexOf(handler);
			if (idx !== -1) list.splice(idx, 1);
		}
		this._peers.forEach((ch) => ch.off(event, handler));
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
		if (this._closed) return;
		this._closed = true;
		this._peers.forEach((ch) => ch.close());
		this._peers.clear();
		this._dispatch("close");
	}

	get peerCount(): number {
		return this._peers.size;
	}

	get closed(): boolean {
		return this._closed;
	}

	private _dispatch(event: string, data?: any): void {
		const list = this._globalListeners.get(event);
		if (!list) return;
		list.slice().forEach((h) => {
			try {
				h(data);
			} catch (e) {
				console.error(
					`[rtc-io] RTCIOBroadcastChannel listener [${event}]`,
					e,
				);
			}
		});
	}
}
