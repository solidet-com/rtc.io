const WebSocket = require("ws");
const http = require("http");
const express = require("express");
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 4009;

const clients = new Map();

wss.on("connection", (ws) => {
    ws.on("message", async (message) => {
        const parsedMessage = JSON.parse(message);

        if (parsedMessage.category === "Login") {
            const { uid, room } = parsedMessage;

            clients.set(uid, { ws, room, uid });

            wss.clients.forEach(function (client) {
                if (client != ws)
                    client.send(JSON.stringify({ category: "MemberJoined", type: "", uid: uid, room: room }));
            });
        }

        if (parsedMessage.type === "offer" || parsedMessage.type === "answer" || parsedMessage.type === "candidate") {
            const room = parsedMessage.room;

            wss.clients.forEach(function (client) {
                if (client != ws) client.send(JSON.stringify(parsedMessage));
            });
        }
    });

    ws.on("close", () => {
        for (const [key, value] of clients.entries()) {
            if (value.ws === ws) {
                clients.delete(key);
                break;
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server started on port ${PORT} :)`);
});
