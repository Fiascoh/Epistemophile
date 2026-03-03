import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME;
const REPO_NAME = process.env.REPO_NAME;
const BRANCH = "main";

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

app.post("/", async (req, res) => {
    const update = req.body;

    if (!update.message || !update.message.text) {
        return res.sendStatus(200);
    }

    const chatId = update.message.chat.id;
    const text = update.message.text;

    try {

        // ===== Telegram Link Extraction =====
        const match = text.match(/https:\/\/t\.me\/([^\/]+)\/(\d+)/);

        if (match) {
            const channelUsername = match[1];
            const messageId = parseInt(match[2]);

            const chatInfo = await axios.get(
                `${TELEGRAM_API}/getChat?chat_id=@${channelUsername}`
            );

            const forward = await axios.get(
                `${TELEGRAM_API}/forwardMessage`,
                {
                    params: {
                        chat_id: chatId,
                        from_chat_id: chatInfo.data.result.id,
                        message_id: messageId
                    }
                }
            );

            const msg = forward.data.result;

            const fileObject =
                msg.document ||
                msg.audio ||
                msg.video;

            if (fileObject) {
                const fileId = fileObject.file_id;

                const fileData = await axios.get(
                    `${TELEGRAM_API}/getFile?file_id=${fileId}`
                );

                const filePath = fileData.data.result.file_path;

                const directLink =
                    `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

                await axios.post(`${TELEGRAM_API}/sendMessage`, {
                    chat_id: chatId,
                    text: `File ID:\n${fileId}\n\nDirect Link:\n${directLink}`
                });
            }
        }

        // ===== GitHub Example Command =====
        if (text === "/github") {

            const response = await axios.get(
                `https://api.github.com/repos/${GITHUB_USERNAME}/${REPO_NAME}/contents/manifest.json?ref=${BRANCH}`,
                {
                    headers: {
                        Authorization: `Bearer ${GITHUB_TOKEN}`,
                        Accept: "application/vnd.github.v3.raw"
                    }
                }
            );

            await axios.post(`${TELEGRAM_API}/sendMessage`, {
                chat_id: chatId,
                text: response.data.substring(0, 1000)
            });
        }

    } catch (err) {
        console.error(err);
    }

    res.sendStatus(200);
});

app.listen(process.env.PORT, () => {
    console.log("Server running");
});
