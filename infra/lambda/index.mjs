import { readFileSync } from "node:fs";
import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

function asset(name) {
  return readFileSync(new URL(`./${name}`, import.meta.url));
}

const STATIC_ASSETS = {
  "/": { body: asset("page.html").toString("utf8"), contentType: "text/html; charset=utf-8" },
  "/manifest.json": { body: asset("manifest.json").toString("utf8"), contentType: "application/manifest+json" },
  "/sw.js": { body: asset("sw.js").toString("utf8"), contentType: "application/javascript" },
  "/icons/icon-180.png": { body: asset("icons/icon-180.png"), contentType: "image/png", binary: true },
  "/icons/icon-192.png": { body: asset("icons/icon-192.png"), contentType: "image/png", binary: true },
  "/icons/icon-512.png": { body: asset("icons/icon-512.png"), contentType: "image/png", binary: true },
  "/audio/william-gong.mp3": { body: asset("audio/william-gong.mp3"), contentType: "audio/mpeg", binary: true },
};

const polly = new PollyClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ROSTER_TABLE = process.env.ROSTER_TABLE_NAME;
const ROSTER_KEY = "roster";

const DEFAULT_ROSTER = [
  { name: "William Gong", num: 17, pos: "SS", song: "Mystical Magical — Benson Boone", clip: "/audio/william-gong.mp3" },
  { name: "Eli Brandt", num: 7, pos: "2B", song: "Jump Around — House of Pain" },
  { name: "Tobias Kim", num: 24, pos: "CF", song: "Enter Sandman — Metallica" },
  { name: "Dawson Pryor", num: 41, pos: "1B", song: "Wagon Wheel — Darius Rucker" },
  { name: "Nia Okafor", num: 3, pos: "C", song: "Run This Town — Jay-Z" },
  { name: "Cal Whitfield", num: 18, pos: "LF", song: "Sicko Mode — Travis Scott" },
  { name: "Reese Alonzo", num: 9, pos: "3B", song: "Callaita — Bad Bunny" },
  { name: "Sam Devries", num: 33, pos: "RF", song: "Seven Nation Army" },
  { name: "Jonah Reyes", num: 5, pos: "P", song: "Levels — Avicii" },
];

async function getRoster() {
  const res = await ddb.send(new GetCommand({ TableName: ROSTER_TABLE, Key: { id: ROSTER_KEY } }));
  if (res.Item && Array.isArray(res.Item.players)) return res.Item.players;
  await ddb.send(new PutCommand({ TableName: ROSTER_TABLE, Item: { id: ROSTER_KEY, players: DEFAULT_ROSTER } }));
  return DEFAULT_ROSTER;
}

async function saveRoster(players) {
  await ddb.send(new PutCommand({ TableName: ROSTER_TABLE, Item: { id: ROSTER_KEY, players } }));
}

function escapeXml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Draws out the name's final sustainable sound (a PA announcer's classic
// flourish) — trailing vowels/sibilants/nasals get repeated; a word ending in
// an unsustainable stop consonant (t/k/p/b/d/g) stretches its last vowel
// instead, since you can't hold a "t" the way you can hold an "s" or "ay".
function stretch(word) {
  const lastChar = word.slice(-1);
  if (/[aeiouyszmnlrfv]/i.test(lastChar)) return word + lastChar.repeat(6);
  return word.replace(/([aeiouAEIOU])(?!.*[aeiouAEIOU])/, (v) => v.repeat(6));
}

function announcementSsml({ num, pos, name }) {
  const parts = name.trim().split(/\s+/);
  const last = parts.pop() || name;
  const first = parts.join(" ");
  const stretchedLast = stretch(last);

  // Generative voices only allow <prosody> around a *complete* sentence, so
  // each clause is wrapped in its own <s> to give prosody a full one to grab.
  return `<speak>
    <prosody rate="110%" volume="loud"><s>Now batting, number ${escapeXml(num)}, ${escapeXml(pos)}.</s></prosody>
    <break time="250ms"/>
    <prosody volume="x-loud"><s>${escapeXml(first)}.</s></prosody>
    <break time="150ms"/>
    <prosody volume="x-loud" rate="60%"><s>${escapeXml(stretchedLast)}!</s></prosody>
  </speak>`;
}

async function speak(ssml) {
  const result = await polly.send(
    new SynthesizeSpeechCommand({
      Text: ssml,
      TextType: "ssml",
      OutputFormat: "mp3",
      VoiceId: "Matthew",
      Engine: "generative",
    }),
  );
  const bytes = await result.AudioStream.transformToByteArray();
  return {
    statusCode: 200,
    headers: { "content-type": "audio/mpeg" },
    body: Buffer.from(bytes).toString("base64"),
    isBase64Encoded: true,
  };
}

// Walk-up songs are real, copyrighted tracks — instead of hosting audio
// ourselves, we resolve the official ~30s iTunes preview clip (streamed
// straight from Apple's own CDN) for exactly this kind of preview use.
async function lookupPreview(songField) {
  const [track, artist] = songField.split("—").map((s) => s.trim());
  const term = artist ? `${track} ${artist}` : track;
  const res = await fetch(`https://itunes.apple.com/search?entity=song&limit=1&term=${encodeURIComponent(term)}`);
  if (!res.ok) throw new Error(`itunes search failed: ${res.status}`);
  const data = await res.json();
  const hit = data.results && data.results[0];
  if (!hit || !hit.previewUrl) throw new Error("no preview found");
  return hit.previewUrl;
}

export const handler = async (event) => {
  const path = event.rawPath || "/";

  const staticAsset = STATIC_ASSETS[path];
  if (staticAsset) {
    return {
      statusCode: 200,
      headers: { "content-type": staticAsset.contentType },
      body: staticAsset.binary ? staticAsset.body.toString("base64") : staticAsset.body,
      isBase64Encoded: !!staticAsset.binary,
    };
  }

  if (path === "/api/roster") {
    const method = event.requestContext?.http?.method;
    try {
      if (method === "GET") {
        const players = await getRoster();
        return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(players) };
      }
      if (method === "PUT") {
        const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body;
        const players = JSON.parse(raw || "[]");
        if (!Array.isArray(players)) return { statusCode: 400, body: "expected a JSON array" };
        await saveRoster(players);
        return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(players) };
      }
      return { statusCode: 405, body: "method not allowed" };
    } catch (err) {
      console.error("roster request failed", err);
      return { statusCode: 502, body: "roster request failed" };
    }
  }

  if (path === "/preview") {
    const song = event.queryStringParameters?.song;
    if (!song) return { statusCode: 400, body: "missing song query param" };
    try {
      const previewUrl = await lookupPreview(song);
      return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ previewUrl }) };
    } catch (err) {
      console.error("preview lookup failed", err);
      return { statusCode: 502, body: "preview lookup failed" };
    }
  }

  if (path === "/speak") {
    const { num, pos, name } = event.queryStringParameters || {};
    if (!num || !pos || !name) return { statusCode: 400, body: "missing num/pos/name query params" };
    try {
      return await speak(announcementSsml({ num, pos, name }));
    } catch (err) {
      console.error("polly synthesis failed", err);
      return { statusCode: 502, body: "speech synthesis failed" };
    }
  }

  return { statusCode: 404, body: "not found" };
};
