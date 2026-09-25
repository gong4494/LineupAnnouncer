import { readFileSync } from "node:fs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

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
};

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const FISH_AUDIO_KEY_PARAM = "/lineup-announcer/fish-audio-api-key";
const FISH_AUDIO_VOICE_ID = "29e4b6f5c8ea4db8bbcfb7ca9720bc6c";

let fishAudioKeyPromise;
function getFishAudioKey() {
  if (!fishAudioKeyPromise) {
    fishAudioKeyPromise = ssm
      .send(new GetParameterCommand({ Name: FISH_AUDIO_KEY_PARAM, WithDecryption: true }))
      .then((r) => r.Parameter.Value);
  }
  return fishAudioKeyPromise;
}
const ROSTER_TABLE = process.env.ROSTER_TABLE_NAME;
const ROSTER_KEY = "roster";

const DEFAULT_ROSTER = [
  { name: "William Gong", num: 17, pos: "SS", song: "Mystical Magical — Benson Boone" },
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

const TEAM_NAME = "Pioneers";

// Fish Audio's S2 models take free-form bracket directives (delivery/emotion
// cues and pauses) inline in the text, interpreted by the model rather than
// spoken aloud — this replaces the old per-sentence SSML <prosody> pacing.
function announcementText({ num, name }) {
  const parts = name.trim().split(/\s+/);
  const last = parts.pop() || name;
  const first = parts.join(" ");
  return `[shouting confidently like a baseball stadium public address announcer] [loud] Now batting for the ${TEAM_NAME}... [long pause] number ${num}... [pause]${first}... [emphasis]${last}!`;
}

async function speak(text) {
  const apiKey = await getFishAudioKey();
  const res = await fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      model: "s2.1-pro-free",
    },
    body: JSON.stringify({
      text,
      reference_id: FISH_AUDIO_VOICE_ID,
      format: "mp3",
      mp3_bitrate: 128,
      prosody: { speed: 1.0, volume: 0 },
    }),
  });
  if (!res.ok) throw new Error(`fish audio error ${res.status}: ${await res.text()}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  return {
    statusCode: 200,
    headers: { "content-type": "audio/mpeg" },
    body: bytes.toString("base64"),
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
    const { num, name } = event.queryStringParameters || {};
    if (!num || !name) return { statusCode: 400, body: "missing num/name query params" };
    try {
      return await speak(announcementText({ num, name }));
    } catch (err) {
      console.error("fish audio synthesis failed", err);
      return { statusCode: 502, body: "speech synthesis failed" };
    }
  }

  return { statusCode: 404, body: "not found" };
};
