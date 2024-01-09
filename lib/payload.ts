type BasePayload = {
	source: string;
	target: string;
};

type MessagePayload<T = any> = {
	data: T;
} & BasePayload;
