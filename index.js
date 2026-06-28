import express from "express";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import pino from "pino";
import dotenv from "dotenv";
import cors from "cors";
import fs from "fs/promises"; // added for auth folder removal

dotenv.config();

const PHONE_NUMBER = "923702723151";
const OWNER_NUMBER = "923702723151";
const SERVICES_IMAGE =
  "https://i.postimg.cc/q7mKjByv/Chat-GPT-Image-Jun-14-2026-05-07-32-PM.png";

// --------------- Global state ---------------
let sock = null;          // current WhatsApp socket
let pairingCode = null;   // current pairing code
let pairResolve = null;   // resolve function for /pair endpoint

// --------------- Express app (created once) ---------------
const app = express();
app.use(express.json());

const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "https://as-developers-tech.vercel.app",
  "https://as-developers.com",
  "https://www.as-developers.com",
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }

      const isAllowed =
        allowedOrigins.includes(origin) ||
        origin.endsWith(".vercel.app");

      if (isAllowed) {
        callback(null, true);
        return;
      }

      callback(new Error("Origin not allowed by CORS"));
    },
    credentials: true,
  }),
);

// --------------- Helpers ---------------
async function sendWaMessage(jid, text) {
  if (!sock) return;
  try {
    await sock.sendMessage(jid, { text });
  } catch (e) {
    console.error("Send error to", jid, e.message);
  }
}

// --------------- Lead Notifications ---------------
async function simpleLeadNotify(from, text) {
  const jid = `${OWNER_NUMBER}@s.whatsapp.net`;
  const cleanNumber = from.replace("@s.whatsapp.net", "");
  const msg = `🚀 *NEW LEAD*

Customer Number: ${cleanNumber}

Customer Message: ${text}`;
  await sendWaMessage(jid, msg);
}

async function appointmentLeadNotify(from, data) {
  const jid = `${OWNER_NUMBER}@s.whatsapp.net`;
  const msg = `📋 *APPOINTMENT BOOKED*

Name: ${data.name}
Phone: ${data.phone}
Email: ${data.email}
Service: ${data.service}
Budget: ${data.budget}
Timeline: ${data.timeline}

Generated With AS Developers AI`;
  await sendWaMessage(jid, msg);
}

// --------------- Appointment state machine ---------------
const userStates = new Map();
const processedLeadMsgIds = new Set();

function startAppointment(from) {
  userStates.set(from, {
    step: "name",
    data: {
      name: "",
      phone: "",
      email: "",
      service: "",
      budget: "",
      timeline: "",
    },
  });
  return "Please enter your *full name*:";
}

const appointmentSteps = [
  "name",
  "phone",
  "email",
  "service",
  "budget",
  "timeline",
];
const nextPrompts = {
  name: "Please enter your *phone number*:",
  phone: "Please enter your *email address*:",
  email: "Which *service* are you interested in?",
  service: "What is your approximate *budget*?",
  budget: "What is your expected *timeline* or deadline?",
  timeline: null,
};

function isServiceRequest(text) {
  const lower = text.toLowerCase();
  const intentPhrases = [
    "i want",
    "i need",
    "looking for",
    "interested",
    "hire",
    "build",
    "develop",
    "create",
    "make",
    "get a",
    "price",
    "cost",
    "quote",
    "project",
    "start",
    "work",
    "help",
    "require",
    "request",
  ];
  return intentPhrases.some((phrase) => lower.includes(phrase));
}

// --------------- Express routes ---------------
app.get("/status", (_req, res) => {
  res.json({
    status: sock?.user ? "connected" : "disconnected",
    user: sock?.user?.id || null,
    uptime: process.uptime(),
  });
});

app.get("/pair", async (req, res) => {
  if (sock?.user) {
    return res.redirect(302, "/status");
  }

  if (pairingCode) {
    return res.json({ pairingCode });
  }

  try {
    const code = await new Promise((resolve) => {
      pairResolve = resolve;
      setTimeout(() => {
        if (pairResolve) {
          pairResolve(null);
          pairResolve = null;
        }
      }, 30000);
    });
    if (code) {
      pairingCode = code;
      return res.json({ pairingCode: code });
    } else {
      return res.status(500).json({ error: "Pairing timed out" });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/notify", async (req, res) => {
  try {
    const { type, data } = req.body;
    if (!type || !data) {
      return res
        .status(400)
        .json({ success: false, error: "type and data required" });
    }

    if (!sock?.user) {
      return res
        .status(503)
        .json({ success: false, error: "Bot not connected" });
    }

    const ownerJid = `${OWNER_NUMBER}@s.whatsapp.net`;
    let ownerMsg = "";
    let customerMsg = "";
    let customerJid = null;

    if (type === "contact") {
      ownerMsg = `📬 *New Contact Form Submission*

*Name:* ${data.name}
*Email:* ${data.email}
*Subject:* ${data.subject}
*Message:* ${data.message}`;
      if (data.phone) {
        ownerMsg += `\n*Phone:* ${data.phone}`;
      }

      if (data.phone) {
        customerJid = `${data.phone}@s.whatsapp.net`;
        customerMsg = `Dear *${data.name}*, thank you for contacting *AS Developers*! We have received your message and will get back to you soon.

Generated With AS Developers AI`;
      }
    } else if (type === "submission") {
      ownerMsg = `📬 *New Form Submission*
*Form ID:* ${data.formId}
*Submitted At:* ${new Date(data.submittedAt).toLocaleString()}

`;
      for (const [key, value] of Object.entries(data.fields)) {
        ownerMsg += `*${key}:* ${value}\n`;
      }
      if (data.phone) {
        customerJid = `${data.phone}@s.whatsapp.net`;
        customerMsg = `Dear *${data.fields.name || "Customer"}*, your form has been submitted successfully. Our team at *AS Developers* will review it shortly.

Generated With AS Developers AI`;
      }
    } else {
      return res.status(400).json({ success: false, error: "Invalid type" });
    }

    await sock.sendMessage(ownerJid, { text: ownerMsg });

    if (customerJid && customerMsg) {
      await sock.sendMessage(customerJid, { text: customerMsg });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("Notify error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// --------------- NEW: Disconnect route ---------------
app.get("/disconnect", async (req, res) => {
  if (!sock) {
    return res.json({ success: true, message: "Already disconnected." });
  }

  try {
    // Properly logout from WhatsApp
    await sock.logout();
    console.log("Logged out successfully.");

    // Remove the auth folder so all session data is wiped
    await fs.rm("./auth", { recursive: true, force: true });
    console.log("Auth folder removed.");

    // Clear global state
    sock = null;
    pairingCode = null;
    pairResolve = null;

    return res.json({
      success: true,
      message: "Disconnected and auth folder removed. Bot stopped.",
    });
  } catch (err) {
    console.error("Disconnect error:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to disconnect.",
    });
  }
});

// --------------- WhatsApp socket (reconnectable) ---------------
async function startBot() {
  // Use a fixed auth folder to preserve session across reconnects
  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;
    console.log("Status:", connection);

    if (connection === "connecting") {
      if (!sock.authState.creds.registered && !pairingCode) {
        try {
          console.log("⏳ Waiting for socket to stabilize...");
          await new Promise((r) => setTimeout(r, 8000));
          console.log("📲 Requesting pairing code...");
          const code = await sock.requestPairingCode(PHONE_NUMBER);
          console.log("\n==============================");
          console.log("PAIRING CODE:", code);
          console.log("==============================\n");
          pairingCode = code;
          if (pairResolve) {
            pairResolve(code);
            pairResolve = null;
          }
        } catch (err) {
          console.log("❌ Pairing Error:", err?.message || err);
          if (pairResolve) {
            pairResolve(null);
            pairResolve = null;
          }
        }
      }
    }

    if (connection === "open") {
      console.log("✅ Bot Connected");
      await sendWaMessage(
        `${PHONE_NUMBER}@s.whatsapp.net`,
        "Bot Successfully Connected ✅"
      );
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log("❌ Disconnected:", statusCode);
      if (statusCode !== DisconnectReason.loggedOut) {
        // Restart the socket after 5 seconds (Express stays alive)
        setTimeout(startBot, 5000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;

    const from = msg.key.remoteJid;

    if (from === "status@broadcast") return;
    if (from.endsWith("@g.us")) return;
    if (msg.key.fromMe) return;
    if (from === `${OWNER_NUMBER}@s.whatsapp.net`) return;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      "";

    if (!text) return;

    console.log("Msg:", text);

    // --------- Appointment flow ---------
    if (userStates.has(from)) {
      const state = userStates.get(from);
      const lowerText = text.trim().toLowerCase();

      if (lowerText === "cancel") {
        userStates.delete(from);
        await sendWaMessage(
          from,
          "Appointment process cancelled. How can I help you?\n\nGenerated With AS Developers AI"
        );
        return;
      }

      state.data[state.step] = text.trim();
      const currentIndex = appointmentSteps.indexOf(state.step);

      if (currentIndex === appointmentSteps.length - 1) {
        userStates.delete(from);
        await appointmentLeadNotify(from, state.data);
        await sendWaMessage(
          from,
          "Thank you! Your appointment has been booked. Our team will contact you soon.\n\nGenerated With AS Developers AI"
        );
      } else {
        const nextStep = appointmentSteps[currentIndex + 1];
        state.step = nextStep;
        userStates.set(from, state);
        await sendWaMessage(
          from,
          nextPrompts[nextStep] + "\n(Reply with 'cancel' to stop)"
        );
      }
      return;
    }

    const lower = text.toLowerCase();

    // --------- Services command ---------
    if (lower === "services") {
      await sock.sendMessage(from, {
        image: { url: SERVICES_IMAGE },
        caption: `*AS Developers Services*

• Custom Web Applications
• Mobile Apps
• E-Commerce Stores
• AI Chatbots
• Instagram Paid Ads
• Graphic Designing
• Video Editing
• Social Media Management
• Business Consulting

Website:
https://www.as-developers.com

Generated With AS Developers AI`,
      });
      return;
    }

    // --------- Simple lead detection ---------
    const leadWords = [
      "website",
      "web app",
      "app",
      "chatbot",
      "store",
      "ecommerce",
      "marketing",
      "service",
      "hire",
      "project",
    ];

    const hasLeadWord = leadWords.some((word) => lower.includes(word));
    if (hasLeadWord && !processedLeadMsgIds.has(msg.key.id)) {
      processedLeadMsgIds.add(msg.key.id);
      await simpleLeadNotify(from, text);
      if (processedLeadMsgIds.size > 1000) processedLeadMsgIds.clear();
    }

    // --------- Trigger appointment booking ---------
    if (hasLeadWord && isServiceRequest(text)) {
      const prompt = startAppointment(from);
      await sendWaMessage(from, prompt + "\n(Reply with 'cancel' to stop)");
      return;
    }
  });
}

// --------------- Start everything ---------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API server running on port ${PORT}`);
});

startBot().catch((err) => console.error("Fatal error:", err));
