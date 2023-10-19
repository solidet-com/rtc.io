let uid = String(Math.floor(Math.random() * 10000));

let ws;
let isCam;
let localStream = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: true,
});

let remoteStream;

/** @type {RTCPeerConnection} */
let peerConnection;

const localVideo = document.getElementById("localVideo");
const switchMediaButton = document.getElementById("switchMediaButton");

const streamFileVideo = document.getElementById("streamFileVideo");

streamFileVideo.onplay = () => {
    let tempStream = streamFileVideo.captureStream();

    tempStream.onaddtrack = (event) => {
        console.log(event.track);
        replacePeerTrack(event.track);
    };
    console.log(tempStream.getTracks());

    localVideo.srcObject = tempStream;
};

const streamFileInput = document.getElementById("streamFileInput");
streamFileInput.onchange = () => {
    streamFileVideo.src = URL.createObjectURL(streamFileInput.files[0]);
    streamFileVideo.load();
    streamFileVideo.play();
};

let currentStream = null;
let queryString = window.location.search;
let urlParams = new URLSearchParams(queryString);
let roomId = urlParams.get("room") || "default";
isCam = !isCam;
const MemberId = String(Math.floor(Math.random() * 10000));
const servers = {
    iceServers: [
        {
            urls: ["stun:stun1.l.google.com:19302", "stun:stun2.l.google.com:19302"],
        },
    ],
};

let constraints = {
    video: {
        width: { min: 640, ideal: 1920, max: 1920 },
        height: { min: 480, ideal: 1080, max: 1080 },
    },
    audio: true,
};

let init = async () => {
    const signalingServerUrl = "wss://<your-signaling-server-url>";

    ws = new WebSocket(signalingServerUrl);

    ws.onopen = () => {
        ws.send(JSON.stringify({ category: "Login", type: "", uid: uid, room: roomId }));
    };

    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        console.log("something happened");
        console.log(JSON.stringify(message.type));
        console.log(JSON.stringify(message));
        if (message.category === "MemberJoined") {
            console.log("MemberJoined");
            handleUserJoined(message.uid);
        }

        if (message.category === "MemberLeft") {
            console.log("MemberLeft");
            handleUserLeft(message.uid);
        }

        if (message.category === "MessageFromPeer") {
            console.log("messageFromPeer");
            handleMessageFromPeer(message, message.uid);
        }
    };

    document.getElementById("localVideo").srcObject = localStream;
};

let handleUserLeft = (MemberId) => {
    document.getElementById("remoteVideo").style.display = "none";
    document.getElementById("localVideo").classList.remove("smallFrame");
};

function addNewTrackToPeer(track) {
    if (!peerConnection) return;

    const sender = peerConnection.getSenders().find((sender) => sender.track.kind === track.kind);
    peerConnection.removeTrack(sender);
    peerConnection.addTrack(track, localStream);
}

function replacePeerTrack(track) {
    if (!peerConnection) return;

    const sender = peerConnection.getSenders().find((sender) => sender.track.kind === track.kind);
    sender.replaceTrack(track);
}

async function toggleMediaSharing() {
    if (currentStream) {
        currentStream.getTracks().forEach((track) => track.stop());
        localVideo.srcObject = null;
    }

    if (isCam) {
        try {
            currentStream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    cursor: "always",
                },
                audio: true,
            });
            isCam = !isCam;
        } catch (error) {
            console.error("Error accessing desktop sharing:", error);
        }
    } else {
        try {
            currentStream = await navigator.mediaDevices.getUserMedia(constraints);
            isCam = !isCam;
        } catch (error) {
            console.error("Error accessing webcam:", error);
        }
    }

    currentStream.getTracks().forEach((track) => replacePeerTracks(track));

    localVideo.srcObject = currentStream;
}

let handleMessageFromPeer = async (message, MemberId) => {
    console.log("GOT MESSAGE FROM PEER");
    console.log(MemberId);
    console.log(message.type);
    console.log(message);
    if (message.type == "offer") {
        console.log("got offer");
        createAnswer(MemberId, message.offer);
    }

    if (message.type == "answer") {
        console.log("got answer");
        addAnswer(message.answer);
    }

    if (message.type == "candidate") {
        console.log("Is this peer connection?");
        console.log(peerConnection == true);
        console.log("Peer Connection State:", peerConnection ? peerConnection.connectionState : "Not created");
        if (peerConnection) {
            peerConnection
                .addIceCandidate(message.candidate)
                .then(() => {
                    console.log("ICE candidate added successfully.");
                })
                .catch((error) => {
                    console.error("Error adding ICE candidate:", error);
                });
        }
    }
};

let handleUserJoined = async (MemberId) => {
    console.log("A new user joined the channel:", MemberId);
    createOffer(MemberId);
};

let createPeerConnection = async (MemberId) => {
    peerConnection = new RTCPeerConnection(servers);

    remoteStream = new MediaStream();
    document.getElementById("remoteVideo").srcObject = remoteStream;
    document.getElementById("remoteVideo").style.display = "block";

    document.getElementById("localVideo").classList.add("smallFrame");

    document.getElementById("localVideo").srcObject = localStream;

    localStream.getTracks().forEach((track) => {
        peerConnection.addTrack(track, localStream);
    });

    peerConnection.ontrack = (event) => {
        event.streams[0].getTracks().forEach((track) => {
            remoteStream.addTrack(track);
        });
    };

    peerConnection.onicecandidate = async (event) => {
        if (event.candidate) {
            console.log("sent candidate");
            ws.send(
                JSON.stringify({
                    type: "candidate",
                    category: "MessageFromPeer",
                    candidate: event.candidate,
                    MemberId: MemberId,
                })
            );
        }
    };
};

let createOffer = async (MemberId) => {
    await createPeerConnection(MemberId);

    let offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    console.log("sent offer");
    ws.send(
        JSON.stringify({
            category: "MessageFromPeer",
            type: "offer",
            offer: offer,
            MemberId: MemberId,
        })
    );
};

let createAnswer = async (MemberId, offer) => {
    console.log("ALOOOOOOOOOOO CREATING ANSWER YAVRU");
    await createPeerConnection(MemberId)
        .then(() => {
            console.log("created peer connection");
        })
        .catch((error) => {
            console.error("Error creating peer connection:", error);
        });

    await peerConnection.setRemoteDescription(offer);

    let answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    console.log("sent answer");

    ws.send(
        JSON.stringify({
            type: "answer",
            category: "MessageFromPeer",
            answer: answer,
            MemberId: MemberId,
        })
    );
};

let addAnswer = async (answer) => {
    if (!peerConnection.currentRemoteDescription) {
        peerConnection.setRemoteDescription(answer);
    }
};

let leaveChannel = async () => {
    await ws.close();
};

init();
switchMediaButton.addEventListener("click", toggleMediaSharing);
function toggleFullScreen(element) {
    if (!document.fullscreenElement) {
        element.requestFullscreen().catch((err) => {
            console.error("Error attempting to enable full-screen mode:", err);
        });
    } else {
        document.exitFullscreen();
    }
}

localVideo.addEventListener("click", () => {
    toggleFullScreen(localVideo);
});

remoteVideo.addEventListener("click", () => {
    toggleFullScreen(remoteVideo);
});
