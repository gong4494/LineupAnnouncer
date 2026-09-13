import { readFileSync } from "node:fs";
import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";

const html = readFileSync(new URL("./page.html", import.meta.url), "utf8");
const williamGongClip = readFileSync(new URL("./audio/william-gong.mp3", import.meta.url));
const polly = new PollyClient({});

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

export const handler = async (event) => {
  const path = event.rawPath || "/";

  if (path === "/audio/william-gong.mp3") {
    return {
      statusCode: 200,
      headers: { "content-type": "audio/mpeg" },
      body: williamGongClip.toString("base64"),
      isBase64Encoded: true,
    };
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

  return {
    statusCode: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: html,
  };
};
