import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
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
const FISH_AUDIO_VOICE_ID = "f3199d67940c4ef3a029a5baf92ee8c2";

let fishAudioKeyPromise;
function getFishAudioKey() {
  if (!fishAudioKeyPromise) {
    fishAudioKeyPromise = ssm
      .send(new GetParameterCommand({ Name: FISH_AUDIO_KEY_PARAM, WithDecryption: true }))
      .then((r) => r.Parameter.Value);
  }
  return fishAudioKeyPromise;
}

// One DynamoDB item per team: { id, name, venue, players }. A Scan lists
// every team for the home page — the table stays tiny (a handful of teams
// at most) so a full scan is simpler and plenty fast, no GSI needed.
const TEAMS_TABLE = process.env.ROSTER_TABLE_NAME;

async function listTeams() {
  const res = await ddb.send(new ScanCommand({ TableName: TEAMS_TABLE }));
  return (res.Items || [])
    .map((t) => ({ id: t.id, name: t.name, venue: t.venue || "", playerCount: (t.players || []).length }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function createTeam({ name, venue }) {
  const team = { id: randomUUID(), name, venue: venue || "", players: [] };
  await ddb.send(new PutCommand({ TableName: TEAMS_TABLE, Item: team }));
  return team;
}

async function getTeam(teamId) {
  const res = await ddb.send(new GetCommand({ TableName: TEAMS_TABLE, Key: { id: teamId } }));
  return res.Item || null;
}

async function saveTeamRoster(teamId, players) {
  const team = await getTeam(teamId);
  if (!team) return null;
  const updated = { ...team, players };
  await ddb.send(new PutCommand({ TableName: TEAMS_TABLE, Item: updated }));
  return updated;
}

// Fish Audio's S2 models take free-form bracket directives (delivery/emotion
// cues and pauses) inline in the text, interpreted by the model rather than
// spoken aloud — this replaces the old per-sentence SSML <prosody> pacing.
function announcementText({ num, name, team }) {
  const parts = name.trim().split(/\s+/);
  const last = parts.pop() || name;
  const first = parts.join(" ");
  return `[shouting confidently like a baseball stadium public address announcer] [loud] Now batting for the ${team}... [long pause] number ${num}... [pause]${first}... [emphasis]${last}!`;
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

function readJsonBody(event) {
  const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body;
  return JSON.parse(raw || "{}");
}

export const handler = async (event) => {
  const path = event.rawPath || "/";
  const method = event.requestContext?.http?.method;

  const staticAsset = STATIC_ASSETS[path];
  if (staticAsset) {
    return {
      statusCode: 200,
      headers: { "content-type": staticAsset.contentType },
      body: staticAsset.binary ? staticAsset.body.toString("base64") : staticAsset.body,
      isBase64Encoded: !!staticAsset.binary,
    };
  }

  if (path === "/api/teams") {
    try {
      if (method === "GET") {
        return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(await listTeams()) };
      }
      if (method === "POST") {
        const { name, venue } = readJsonBody(event);
        if (!name || !name.trim()) return { statusCode: 400, body: "missing team name" };
        const team = await createTeam({ name: name.trim(), venue: (venue || "").trim() });
        return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(team) };
      }
      return { statusCode: 405, body: "method not allowed" };
    } catch (err) {
      console.error("teams request failed", err);
      return { statusCode: 502, body: "teams request failed" };
    }
  }

  const rosterMatch = path.match(/^\/api\/teams\/([^/]+)\/roster$/);
  if (rosterMatch) {
    const teamId = decodeURIComponent(rosterMatch[1]);
    try {
      if (method === "GET") {
        const team = await getTeam(teamId);
        if (!team) return { statusCode: 404, body: "team not found" };
        return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(team.players || []) };
      }
      if (method === "PUT") {
        const players = readJsonBody(event);
        if (!Array.isArray(players)) return { statusCode: 400, body: "expected a JSON array" };
        const team = await saveTeamRoster(teamId, players);
        if (!team) return { statusCode: 404, body: "team not found" };
        return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(team.players) };
      }
      return { statusCode: 405, body: "method not allowed" };
    } catch (err) {
      console.error("team roster request failed", err);
      return { statusCode: 502, body: "team roster request failed" };
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
    const { num, name, team } = event.queryStringParameters || {};
    if (!num || !name || !team) return { statusCode: 400, body: "missing num/name/team query params" };
    try {
      return await speak(announcementText({ num, name, team }));
    } catch (err) {
      console.error("fish audio synthesis failed", err);
      return { statusCode: 502, body: "speech synthesis failed" };
    }
  }

  return { statusCode: 404, body: "not found" };
};
