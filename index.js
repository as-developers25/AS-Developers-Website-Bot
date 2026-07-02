import express from "express";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import pino from "pino";
import dotenv from "dotenv";
import cors from "cors";
import fs from "fs/promises";

dotenv.config();

const PHONE_NUMBER = "923702723151";
const OWNER_NUMBER = "923702723151";
const SERVICES_IMAGE =
  "https://i.postimg.cc/q7mKjByv/Chat-GPT-Image-Jun-14-2026-05-07-32-PM.png";

// --------------- Global state ---------------
let sock = null;
let isBotStarting = false;   // prevents multiple simultaneous starts

// --------------- Express app ---------------
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
  })
);

// --------------- Helper ---------------
async function sendWaMessage(jid, text) {
  if (!sock) return;
  try {
    await sock.sendMessage(jid, { text });
  } catch (e) {
    console.error("Send error to", jid, e.message);
  }
}

// --------------- Routes ---------------
app.get("/status", (_req, res) => {
  res.json({
    status: sock?.user ? "connected" : "disconnected",
    user: sock?.user?.id || null,
    uptime: process.uptime(),
  });
});

// --------------- Improved /pair route ---------------
app.get("/pair", async (req, res) => {
  // If already connected, redirect to status
  if (sock?.user) {
    return res.redirect(302, "/status");
  }

  // If bot is dead (null) or disconnected, restart it automatically
  if (!sock) {
    if (isBotStarting) {
      return res.status(503).json({ error: "Bot restart in progress, please wait a moment..." });
    }
    try {
      console.log("⚡ Bot is dead. Starting new session...");
      await startBot();
    } catch (err) {
      console.error("Failed to start bot:", err);
      return res.status(500).json({ error: "Could not start bot. Check logs." });
    }
  }

  // Now sock definitely exists, request pairing code
  try {
    console.log("📲 Requesting pairing code...");
    const code = await sock.requestPairingCode(PHONE_NUMBER);
    console.log("✅ PAIRING CODE:", code);
    return res.json({ pairingCode: code });
  } catch (err) {
    console.error("❌ Pairing Error:", err?.message || err);
    return res.status(500).json({ error: err.message || "Failed to get pairing code" });
  }
});

// --------------- Disconnect route ---------------
app.get("/disconnect", async (req, res) => {
  if (!sock) {
    return res.json({ success: true, message: "Already disconnected." });
  }

  try {
    await sock.logout();
    console.log("Logged out successfully.");

    await fs.rm("./auth", { recursive: true, force: true });
    console.log("Auth folder removed.");

    sock = null;   // completely dead now
    return res.json({
      success: true,
      message: "Disconnected & auth folder deleted. Bot stopped. Use /pair to start fresh.",
    });
  } catch (err) {
    console.error("Disconnect error:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to disconnect.",
    });
  }
});

// --------------- Notify (unchanged) ---------------
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
        customerMsg = `Dear *${data.name}*, thank you for contacting *AS Developers*! We have received your message and will get back to you soon.\n\nGenerated With AS Developers AI`;
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
        customerMsg = `Dear *${data.fields.name || "Customer"}*, your form has been submitted successfully. Our team at *AS Developers* will review it shortly.\n\nGenerated With AS Developers AI`;
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

// --------------- WhatsApp socket (reconnectable) ---------------
async function startBot() {
  // Prevent overlapping starts
  if (isBotStarting) return;
  isBotStarting = true;

  try {
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
      console.log("Connection status:", connection);

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
        // Reconnect only if not logged out (and not a manual disconnect)
        if (statusCode !== DisconnectReason.loggedOut) {
          sock = null; // socket dead
          setTimeout(() => {
            startBot().catch(console.error);
          }, 5000);
        } else {
          // Logged out manually – don't auto-restart
          sock = null;
        }
      }
    });

    // Incoming messages – only the "services" command
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

      console.log("Message:", text);

      const lower = text.toLowerCase();

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
      }
    });

    console.log("✅ Bot instance created and ready for pairing.");
  } catch (err) {
    console.error("startBot error:", err);
  } finally {
    isBotStarting = false;
  }
}

// --------------- Start server ---------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API server running on port ${PORT}`);
  // initial bot start
  startBot().catch((err) => console.error("Initial start failed:", err));
});
