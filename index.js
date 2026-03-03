import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const { BOT_TOKEN, GITHUB_TOKEN, GITHUB_USERNAME, REPO_NAME } = process.env;
const BRANCH = "main";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GITHUB_API = `https://api.github.com/repos/${GITHUB_USERNAME}/${REPO_NAME}/contents/manifest.json`;

// Helper: Get manifest from GitHub
async function getManifest() {
  try {
    const res = await axios.get(`${GITHUB_API}?ref=${BRANCH}`, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}` }
    });
    const content = Buffer.from(res.data.content, 'base64').toString('utf-8');
    return { data: JSON.parse(content), sha: res.data.sha };
  } catch (err) {
    return { data: { files: [] }, sha: null };
  }
}

// Helper: Update manifest on GitHub
async function updateManifest(manifest, sha) {
  const content = Buffer.from(JSON.stringify(manifest, null, 2)).toString('base64');
  await axios.put(GITHUB_API, {
    message: "Update manifest",
    content,
    sha,
    branch: BRANCH
  }, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}` }
  });
}

// Helper: Get fresh Telegram File Path
async function getFreshPath(fileId) {
  const res = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  return res.data.result.file_path;
}

app.post("/", async (req, res) => {
  const update = req.body;
  if (!update.message) return res.sendStatus(200);

  const chatId = update.message.chat.id;
  const text = update.message.text || "";
  const { data: manifestData, sha } = await getManifest();
  let manifest = manifestData.files || [];

  try {
    const urlMatch = text.match(/https:\/\/t\.me\/([^\/]+)\/(\d+)/);

    // CASE 1: Adding a new file via Link
    if (urlMatch) {
      const channelUsername = urlMatch[1];
      const messageId = parseInt(urlMatch[2], 10);

      const chatInfo = await axios.get(`${TELEGRAM_API}/getChat?chat_id=@${channelUsername}`);
      const forward = await axios.get(`${TELEGRAM_API}/forwardMessage`, {
        params: { chat_id: chatId, from_chat_id: chatInfo.data.result.id, message_id: messageId }
      });

      const msg = forward.data.result;
      const fileObject = msg.document || msg.audio || msg.video;

      if (fileObject) {
        const filePath = await getFreshPath(fileObject.file_id);
        const fileName = fileObject.file_name || fileObject.title || "Unknown";

        // Remove old entry if exists to avoid duplicates
        manifest = manifest.filter(f => f.name !== fileName);
        
        manifest.push({
          name: fileName,
          telegram_file_id: fileObject.file_id,
          telegram_file_path: filePath,
          updated_at: new Date().toISOString()
        });

        await updateManifest({ files: manifest }, sha);
        const directLink = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: `✅ File Saved/Updated!\n\nName: ${fileName}\nNew Link: ${directLink}`
        });
      }
    } 
    // CASE 2: Refreshing an existing file by sending its NAME
    else if (text.length > 2 && text !== "/github") {
      const fileIndex = manifest.findIndex(f => f.name.toLowerCase().includes(text.toLowerCase()));

      if (fileIndex !== -1) {
        const file = manifest[fileIndex];
        const newPath = await getFreshPath(file.telegram_file_id);
        
        manifest[fileIndex].telegram_file_path = newPath;
        manifest[fileIndex].updated_at = new Date().toISOString();

        await updateManifest({ files: manifest }, sha);
        
        const newLink = `https://api.telegram.org/file/bot${BOT_TOKEN}/${newPath}`;
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: `🔄 Link Refreshed!\n\nFile: ${file.name}\nNew CDN Link: ${newLink}`
        });
      }
    }

    if (text === "/github") {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: `📊 Manifest has ${manifest.length} files.`
      });
    }

  } catch (err) {
    console.error("Error:", err.message);
  }
  res.sendStatus(200);
});

app.listen(process.env.PORT || 3000);
