import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const { BOT_TOKEN, GITHUB_TOKEN, GITHUB_USERNAME, REPO_NAME } = process.env;
const BRANCH = "main";

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GITHUB_API = `https://api.github.com/repos/${GITHUB_USERNAME}/${REPO_NAME}/contents/manifest.json`;

/* ============================= */
/* GitHub Manifest Helpers       */
/* ============================= */

async function getManifest() {
  try {
    const res = await axios.get(`${GITHUB_API}?ref=${BRANCH}`, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}` }
    });

    const content = Buffer.from(res.data.content, "base64").toString("utf-8");
    return { data: JSON.parse(content), sha: res.data.sha };

  } catch (err) {
    // Only treat 404 as "manifest doesn't exist yet"
    if (err.response?.status === 404) {
      return { data: { files: [] }, sha: null };
    }

    console.error("GitHub fetch error:", err.response?.data || err.message);
    throw err;
  }
}

async function updateManifest(manifest, sha) {
  const content = Buffer.from(
    JSON.stringify(manifest, null, 2)
  ).toString("base64");

  await axios.put(
    GITHUB_API,
    {
      message: "Update manifest",
      content,
      sha,
      branch: BRANCH
    },
    {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}` }
    }
  );
}

/* ============================= */
/* Telegram Helpers              */
/* ============================= */

async function getFreshPath(fileId) {
  const res = await axios.get(`${TELEGRAM_API}/getFile`, {
    params: { file_id: fileId }
  });

  return res.data.result.file_path;
}

/* ============================= */
/* Health Check                  */
/* ============================= */

app.get("/", (req, res) => {
  res.send("Bot is awake and running! 🚀");
});

/* ============================= */
/* Main Webhook                  */
/* ============================= */

app.post("/", async (req, res) => {
  const update = req.body;

  const msg = update.channel_post || update.message;
  if (!msg) return res.sendStatus(200);

  const chatId = msg.chat.id;
  const text = msg.text || msg.caption || "";
  const fileObject = msg.document || msg.audio || msg.video;

  try {
    const { data: manifestData, sha } = await getManifest();
    let manifest = manifestData.files || [];

    const urlMatch = text.match(/https:\/\/t\.me\/([^\/]+)\/(\d+)/);

    /* ===================================== */
    /* CASE 1 — Add New File                */
    /* ===================================== */

    if (fileObject || urlMatch) {
      let targetFile = fileObject;
      let originMessageId = msg.message_id;

      // If link only, forward to extract file
      if (urlMatch && !fileObject) {
        const channelUsername = urlMatch[1];
        const messageId = parseInt(urlMatch[2], 10);

        try {
          const forward = await axios.get(`${TELEGRAM_API}/forwardMessage`, {
            params: {
              chat_id: chatId,
              from_chat_id: `@${channelUsername}`,
              message_id: messageId
            }
          });

          const forwardMsg = forward.data.result;
          originMessageId = forwardMsg.message_id;
          targetFile =
            forwardMsg.document ||
            forwardMsg.audio ||
            forwardMsg.video;

        } catch (e) {
          console.error("Failed to fetch link details:", e.message);
        }
      }

      if (targetFile) {
        const filePath = await getFreshPath(targetFile.file_id);
        const fileName =
          targetFile.file_name ||
          targetFile.title ||
          `file_${Date.now()}`;

        // Remove duplicates by file_unique_id (stronger than name)
        manifest = manifest.filter(
          f => f.file_unique_id !== targetFile.file_unique_id
        );

        manifest.push({
          name: fileName,
          telegram_file_id: targetFile.file_id,
          telegram_file_unique_id: targetFile.file_unique_id,
          telegram_file_path: filePath,
          mime_type: targetFile.mime_type || null,
          file_size: targetFile.file_size || null,
          message_id: originMessageId,
          updated_at: new Date().toISOString()
        });

        await updateManifest({ files: manifest }, sha);

        const directLink =
          `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text:
            `✅ File Logged to GitHub!\n\n` +
            `Name: ${fileName}\n` +
            `Size: ${targetFile.file_size || "Unknown"} bytes\n` +
            `CDN Link:\n${directLink}`
        });
      }
    }

    /* ===================================== */
    /* CASE 2 — Refresh by Filename          */
    /* ===================================== */

    else if (text.length > 2 && text !== "/github") {
      const fileIndex = manifest.findIndex(f =>
        f.name.toLowerCase().includes(text.toLowerCase())
      );

      if (fileIndex !== -1) {
        const file = manifest[fileIndex];
        const newPath = await getFreshPath(file.telegram_file_id);

        manifest[fileIndex].telegram_file_path = newPath;
        manifest[fileIndex].updated_at = new Date().toISOString();

        await updateManifest({ files: manifest }, sha);

        const newLink =
          `https://api.telegram.org/file/bot${BOT_TOKEN}/${newPath}`;

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text:
            `🔄 Link Refreshed!\n\n` +
            `File: ${file.name}\n` +
            `New CDN Link:\n${newLink}`
        });
      }
    }

    /* ===================================== */
    /* CASE 3 — Manifest Status              */
    /* ===================================== */

    if (text === "/github") {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: `📊 Manifest Status: ${manifest.length} files tracked.`
      });
    }

  } catch (err) {
    console.error("Error Processing Update:", err.response?.data || err.message);
  }

  res.sendStatus(200);
});

app.listen(process.env.PORT || 3000);
