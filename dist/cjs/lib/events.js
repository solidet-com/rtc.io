"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CUSTOM_CHANNEL_PREFIX = exports.CTRL_CHANNEL_LABEL = exports.INTERNAL_EVENT_PREFIX = exports.RtcioEvents = void 0;
exports.RtcioEvents = {
    OFFER: "#rtcio:offer",
    ANSWER: "#rtcio:answer",
    CANDIDATE: "#rtcio:candidate",
    MESSAGE: "#rtcio:message",
    STREAM_META: "#rtcio:stream-meta",
    INIT_OFFER: "#rtcio:init-offer",
};
exports.INTERNAL_EVENT_PREFIX = "#rtcio:";
exports.CTRL_CHANNEL_LABEL = "rtcio:ctrl";
exports.CUSTOM_CHANNEL_PREFIX = "rtcio:ch:";
