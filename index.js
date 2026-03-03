import express from "express";
import axios from "axios";
import base64 from "base-64";

const app = express();
app.use(express.json());

// Environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME;
const REPO_NAME = process.env.REPO_NAME;
const BRANCH = "main";

// Validate environment variables
if (!BOT_TOKEN || !GITHUB_TOKEN || !GITHUB_USERNAME || !REPO_NAME) {
    throw new Error("Missing required environment variables: BOT_TOKEN, GITHUB_TOKEN, GITHUB_USERNAME, REPO_NAME");
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GITHUB_API = `https://api.github.com/repos/${GITHUB_USERNAME}/${REPO_NAME}/contents/manifest.json`;

// Helper: Get current manifest.json or empty
async function getManifest() {
  try {
    const res = await axios.get(`${GITHUB_API}?ref=${BRANCH}`, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json"
      }
    });
    return { data: JSON.parse(base64.decode(res.data.content)), sha: res.data.sha };
  } catch (err) {
    // File doesn't exist yet
    return { data: { files: [] }, sha: null };
  }
}

// Helper: Update manifest.json
async function updateManifest(manifest, sha) {
  const encodedContent = base64.encode(JSON.stringify(manifest, null, 2));
  const body = {
    message: sha ? "Update manifest" : "Create manifest",
    content: encodedContent,
    branch: BRANCH,
  };
  if (sha) body.sha = sha;

  await axios.put(GITHUB_API, body, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
}

// Main webhook endpoint
app.post("/", async (req, res) => {
  const update = req.body;

  if (!update.message) return res.sendStatus(200);
  const chatId = update.message.chat.id;
  const text = update.message.text || "";

  try {
    // Check for Telegram link (optional)
    const match = text.match(/https:\/\/t\.me\/([^\/]+)\/(\d+)/);

    if (match) {
      const channelUsername = match[1];
      const messageId = parseInt(match[2], 10);

      const chatInfo = await axios.get(`${TELEGRAM_API}/getChat?chat_id=@${channelUsername}`);
      const forward = await axios.get(`${TELEGRAM_API}/forwardMessage`, {
        params: {
          chat_id: chatId,
          from_chat_id: chatInfo.data.result.id,
          message_id: messageId
        }
      });

      const msg = forward.data.result;
      const fileObject = msg.document || msg.audio || msg.video;

      if (fileObject) {
        const fileId = fileObject.file_id;
        const fileData = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
        const filePath = fileData.data.result.file_path;

        // Get current manifest
        const { data: manifestData, sha } = await getManifest();
        const manifest = manifestData.files || [];

        // Check if file already exists
        if (!manifest.some(f => f.telegram_file_id === fileId)) {
          manifest.push({
            name: fileObject.file_name || fileObject.title || "Unknown",
            telegram_file_id: fileId,
            telegram_file_path: filePath,
            type: fileObject.mime_type || "unknown"
          });

          // Update GitHub
          await updateManifest({ files: manifest }, sha);
        }

        const directLink = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: `File added to manifest!\n\nName: ${fileObject.file_name || fileObject.title}\nDirect Link: ${directLink}`
        });
      } else {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "No file found in that message."
        });
      }
    }

    // GitHub manual fetch command
    if (text === "/github") {
      const { data: manifestData } = await getManifest();
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: JSON.stringify(manifestData, null, 2).substring(0, 4000) // limit Telegram message size
      });
    }

  } catch (err) {
    console.error(err.response?.data || err.message);
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: "Error processing request."
    });
  }

  res.sendStatus(200);
});

app.listen(process.env.PORT || 3000, () => console.log("Server running"));