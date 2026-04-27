"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RTCIOChannel = exports.QUEUE_BUDGET = exports.LOW_WATERMARK = exports.HIGH_WATERMARK = void 0;
exports.HIGH_WATERMARK = 16777216; // 16 MB — pause sending above this
exports.LOW_WATERMARK = 1048576; //  1 MB — resume sending below this
exports.QUEUE_BUDGET = 1048576; //  1 MB default pre-open queue budget
class RTCIOChannel {
    constructor(queueBudget = exports.QUEUE_BUDGET) {
        this._dc = null;
        this._listeners = new Map();
        this._queue = [];
        this._queueBytes = 0;
        this._queueBudget = queueBudget;
    }
    _attach(dc) {
        this._dc = dc;
        dc.binaryType = "arraybuffer";
        dc.bufferedAmountLowThreshold = exports.LOW_WATERMARK;
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
                    this._dispatchLocal(e, d);
                }
                catch (_a) {
                    this._dispatchLocal("error", new Error("RTCIOChannel: invalid JSON envelope"));
                }
            }
            else {
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
    _isAttached() {
        return this._dc !== null;
    }
    emit(eventName, payload) {
        const message = JSON.stringify({ e: eventName, d: payload !== null && payload !== void 0 ? payload : null });
        this._write(message);
    }
    send(data) {
        return this._write(data);
    }
    on(event, handler) {
        let list = this._listeners.get(event);
        if (!list) {
            list = [];
            this._listeners.set(event, list);
        }
        list.push(handler);
        return this;
    }
    off(event, handler) {
        const list = this._listeners.get(event);
        if (!list)
            return this;
        const idx = list.indexOf(handler);
        if (idx !== -1)
            list.splice(idx, 1);
        return this;
    }
    once(event, handler) {
        const wrapper = (...args) => {
            this.off(event, wrapper);
            handler(...args);
        };
        return this.on(event, wrapper);
    }
    close() {
        const dc = this._dc;
        if (dc && dc.readyState !== "closed" && dc.readyState !== "closing") {
            dc.close();
        }
        this._queue = [];
        this._queueBytes = 0;
    }
    get readyState() {
        var _a, _b;
        return (_b = (_a = this._dc) === null || _a === void 0 ? void 0 : _a.readyState) !== null && _b !== void 0 ? _b : "connecting";
    }
    get bufferedAmount() {
        var _a, _b;
        return (_b = (_a = this._dc) === null || _a === void 0 ? void 0 : _a.bufferedAmount) !== null && _b !== void 0 ? _b : 0;
    }
    _dispatchLocal(event, data) {
        const list = this._listeners.get(event);
        if (!list)
            return;
        // snapshot to allow safe off/once during dispatch
        list.slice().forEach((h) => {
            try {
                h(data);
            }
            catch (e) {
                console.error(`[rtc-io] RTCIOChannel listener [${event}]`, e);
            }
        });
    }
    _write(data) {
        const dc = this._dc;
        if (dc &&
            dc.readyState === "open" &&
            dc.bufferedAmount < exports.HIGH_WATERMARK &&
            this._queue.length === 0) {
            try {
                dc.send(data);
                return true;
            }
            catch (e) {
                this._dispatchLocal("error", e);
                return false;
            }
        }
        return this._enqueue(data);
    }
    _enqueue(data) {
        const size = typeof data === "string" ? data.length * 2 : data.byteLength;
        if (this._queueBytes + size > this._queueBudget) {
            this._dispatchLocal("error", new Error("RTCIOChannel: queue budget exceeded — wait for 'drain' before sending more"));
            return false;
        }
        this._queue.push(data);
        this._queueBytes += size;
        return false;
    }
    _flush() {
        while (this._queue.length > 0) {
            const dc = this._dc;
            if (!dc || dc.readyState !== "open")
                break;
            if (dc.bufferedAmount >= exports.HIGH_WATERMARK)
                break;
            const item = this._queue.shift();
            const size = typeof item === "string"
                ? item.length * 2
                : item.byteLength;
            this._queueBytes -= size;
            try {
                dc.send(item);
            }
            catch (e) {
                this._dispatchLocal("error", e);
                break;
            }
        }
    }
}
exports.RTCIOChannel = RTCIOChannel;
