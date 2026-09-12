const CHANNELS = {
  sms: [
    "This turn arrived as an SMS text.",
    "Expect terse fragments, abbreviations, and missing punctuation.",
    "The reply goes back as one plain SMS -- never markdown, links, or emoji.",
  ].join("\n"),
  imessage: [
    "This turn arrived as an iMessage text.",
    "The reply goes back as plain iMessage text -- no markdown or emoji.",
  ].join("\n"),
  voice: [
    "This turn arrived as transcribed speech on a phone call.",
    "Expect disfluencies, restarts, and missing punctuation; numbers may be",
    'spelled out ("running twenty late" means delayMinutes 20).',
    "The reply is spoken aloud -- still return only the JSON.",
  ].join("\n"),
};

/**
 * Channel-specific lines of the classify system prompt. Unknown or
 * missing channels get the SMS rules -- the most conservative profile.
 */
function channelPrompt(channel) {
  return CHANNELS[channel] ?? CHANNELS.sms;
}

module.exports = { channelPrompt, CHANNELS };
