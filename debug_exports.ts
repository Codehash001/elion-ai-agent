
import * as google from "@livekit/agents-plugin-google";
import { voice } from "@livekit/agents";

console.log("Google Plugin Exports:", Object.keys(google));

try {
    // @ts-ignore
    if (google.realtime) console.log("google.realtime keys:", Object.keys(google.realtime));
    // @ts-ignore
    if (google.beta) console.log("google.beta keys:", Object.keys(google.beta));
} catch (e) {
    console.log("Error checking nested:", e);
}

const session = new voice.AgentSession({} as any);
console.log("AgentSession prototype:", Object.getOwnPropertyNames(Object.getPrototypeOf(session)));
