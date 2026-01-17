import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  voice,
  llm,
  inference,
} from "@livekit/agents";
import * as silero from "@livekit/agents-plugin-silero";
import * as google from "@livekit/agents-plugin-google";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { NexHealthClient, formatSlotsForAgent } from "./lib/nexhealth.js";

dotenv.config({ path: ".env" });

// Initialize Supabase client for agent - using service role key to bypass RLS
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn("WARNING: Missing SUPABASE env vars - agent will fail to load business config");
}

const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey)
  : null;

// Business config interface (transformed from Supabase schema)
interface GeneralInfo {
  practiceName: string;
  phone: string;
  software: string;
  noShowFee: number;
  address: string;
  hours: string;
  services: string;
  rawHours: any; // Raw operating hours object from Supabase for agent logic
}

interface AgentConfig {
  agentName?: string;
  greeting?: string;
  pretendence?: boolean; // If true, pretend as human. If false, identify as AI agent
  voice?: string; // Gemini TTS voice (Puck, Charon, Kore, etc.)
}

// NexHealth config loaded per-business
interface NexHealthConfig {
  subdomain?: string;
  locationId?: string;
}

// Dental Bridge config loaded per-business
interface DentalBridgeConfig {
  locationId?: string;
}

// PMS provider type
type PMSProvider = 'nexhealth' | 'dental_bridge' | null;

interface BusinessConfig {
  id: string;
  name: string;
  generalInfo: GeneralInfo;
  agentConfig: AgentConfig;
  pmsProvider: PMSProvider;
  nexhealthConfig: NexHealthConfig;
  dentalBridgeConfig: DentalBridgeConfig;
}

// Format operating hours object to string
function formatOperatingHours(hours: Record<string, string> | null): string {
  if (!hours) return "Not specified";
  const formatted = Object.entries(hours)
    .filter(([, time]) => time && time !== "Closed")
    .map(([day, time]) => `${day.charAt(0).toUpperCase() + day.slice(1)}: ${time}`)
    .join(", ");
  return formatted || "Not specified";
}

// Load business config from Supabase with timeout to prevent hanging
async function loadBusinessConfig(businessId?: string): Promise<BusinessConfig | null> {
  const TIMEOUT_MS = 10000; // 10 second timeout

  const timeoutPromise = new Promise<null>((_, reject) => {
    setTimeout(() => reject(new Error("Config load timeout")), TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      loadBusinessConfigInternal(businessId),
      timeoutPromise
    ]);
  } catch (error) {
    console.error("[Agent] loadBusinessConfig failed:", error);
    return null;
  }
}

async function loadBusinessConfigInternal(businessId?: string): Promise<BusinessConfig | null> {
  try {
    if (!supabase) {
      console.error("[Agent] Supabase client not initialized - check env vars");
      return null;
    }
    console.log("[Agent] Loading business config from Supabase, businessId:", businessId);

    // Fetch business from Supabase
    let businesses: any[] | null = null;
    let bizError: any = null;

    // First try to fetch by specific businessId
    if (businessId) {
      const result = await supabase.from("businesses").select("*").eq("id", businessId).limit(1);
      businesses = result.data;
      bizError = result.error;
    }

    // If no business found by ID, fallback to fetching any available business
    if (!businesses || businesses.length === 0) {
      console.log("[Agent] Business ID not found, fetching first available business...");
      const result = await supabase.from("businesses").select("*").limit(1);
      businesses = result.data;
      bizError = result.error;
    }

    if (bizError) {
      console.error("[Agent] Error fetching business:", bizError);
      return null;
    }

    if (!businesses || businesses.length === 0) {
      console.error("[Agent] No business found in database");
      return null;
    }

    const business = businesses[0];
    console.log("[Agent] Found business:", business.name);

    // Fetch agent config for this business
    const { data: agents } = await supabase
      .from("business_agents")
      .select("*")
      .eq("business_id", business.id)
      .limit(1);

    const agent = agents?.[0];
    console.log("[Agent] Found agent:", agent?.agent_name || "Default");

    // Transform to BusinessConfig format
    const config: BusinessConfig = {
      id: business.id,
      name: business.name,
      generalInfo: {
        practiceName: business.name,
        phone: business.phone_no || "Not provided",
        software: business.practice_software || "Not specified",
        noShowFee: business.no_show_fees || 0,
        address: business.address || "Not provided",
        hours: formatOperatingHours(business.operating_hours),
        services: Array.isArray(business.services) ? business.services.join(", ") : (business.services || "Not specified"),
        rawHours: business.operating_hours,
      },
      agentConfig: {
        agentName: agent?.agent_name,
        greeting: agent?.greeting_text,
        pretendence: agent?.pretendence ?? false,
        voice: agent?.voice || "Puck",
      },
      nexhealthConfig: {
        subdomain: business.nexhealth_subdomain,
        locationId: business.nexhealth_location_id,
      },
      pmsProvider: business.pms_provider as PMSProvider,
      dentalBridgeConfig: {
        locationId: business.dental_bridge_location_id,
      },
    };

    console.log(`[Agent] Using PMS provider: ${config.pmsProvider || 'none'}`);

    return config;
  } catch (error) {
    console.error("[Agent] Failed to load business config:", error);
    return null;
  }
}

// NexHealth API key is global, but subdomain/locationId are per-business
const nexhealthApiKey = process.env.NEXHEALTH_API_KEY;

if (!nexhealthApiKey) {
  console.warn("WARNING: Missing NEXHEALTH_API_KEY env var - booking features will fail");
}

// NexHealth-based dental assistant agent (legacy class kept for reference)
// This class is no longer used - createDynamicAgent is the main entry point

// Dynamic agent factory based on business config - uses NexHealth for appointment booking
function createDynamicAgent(config: BusinessConfig) {
  const today = new Date().toISOString().split('T')[0];
  const { generalInfo, agentConfig, nexhealthConfig } = config;
  const agentName = agentConfig.agentName!; // Already validated before this call
  const pretendence = agentConfig.pretendence ?? false;

  // Create NexHealthClient per-business (if configured)
  const nexhealth = nexhealthApiKey && nexhealthConfig.subdomain
    ? new NexHealthClient({
      apiKey: nexhealthApiKey,
      subdomain: nexhealthConfig.subdomain,
    })
    : null;
  const locationId = nexhealthConfig.locationId ? parseInt(nexhealthConfig.locationId) : 0;

  // Track patient ID after creation/search for booking
  let currentPatientId: number | null = null;
  let currentProviderId: number | null = null;

  // Set identity instructions based on pretendence
  const identityInstructions = pretendence
    ? `You are ${agentName}, a receptionist at ${generalInfo.practiceName}. Act naturally as a helpful human receptionist.`
    : `You are ${agentName}, an AI assistant receptionist at ${generalInfo.practiceName}. When asked, honestly say you are an AI assistant. Never pretend to be human.`;

  const fullInstructions = `${identityInstructions} Today is ${today}.


GOAL: Helps callers with their inquiries and book appointments efficiently and naturally.

TOOLS:
- getAvailableSlots: Check availability (uses practice operating hours).
- searchPatient: Find existing patient by name/phone.
- searchPatientByEmail: Find by email.
- createPatient: Register new patient (Name, Email, Phone, DOB, Gender required).
- bookAppointment: Finalize booking (Patient info + Time).
- getPracticeInfo: General Q&A (Hours, location, etc).

CRITICAL RULES:
- **Identity**: You know your name and role. DO NOT use tools to find out who you are.
- **Tool Usage**: Use tools ONLY when you need external data.
- **Phasing**: Do NOT say "Let me check that" for simple questions.
- **Tone**: Be warm, professional, and efficient.
- **Style**: OCCASIONALLY use natural fillers like "ummm", "aaah", "let me see" to sound more human. Don't overdo it, but use them when processing or transitioning.
- **Brevity**: Keep responses under 2 sentences unless explaining complex info.
- **GREETING**: Always start the conversation by introducing yourself. Do NOT ask for the user's name immediately unless they want to book an appointment.

PROCEDURES:
1. **GREETING**: Wait for the user to respond to your greeting.
2. **INQUIRY**: Answer questions about hours, services, location, etc.
3. **BOOKING (Only if user asks to book)**:
   a. **STEP 1**: Ask for **First Name**. Wait for answer.
   b. **STEP 2**: Ask for **Last Name**. Wait for answer.
   c. **STEP 3**: Ask for **Phone Number**. Wait for answer.
   d. **STEP 4**: Call \`searchPatient\` with the collected info.
      - **IF FOUND**: SILENTLY acknowledge it. **DO NOT** say "I found John Smith". Just say something like "Okay, I have your file pulled up." or "Great, thanks." and immediately move to asking about appointment times.
      - **IF NOT FOUND**: The tool will tell you. You can say "I couldn't find a file with that info..." and ask for Email, DOB, Gender to \`createPatient\`.
   e. Check availability -> \`getAvailableSlots\`.
   f. Offer 2-3 slots based on the operating hours returned.
   g. Confirm & Book -> \`bookAppointment\`.

One question at a time. Wait for user answer.

Practice: ${generalInfo.practiceName}
Address: ${generalInfo.address}
Phone: ${generalInfo.phone}
Hours: ${generalInfo.hours}
Services: ${generalInfo.services}
No-Show Fee: $${generalInfo.noShowFee}
`;

  return class DynamicAgent extends voice.Agent {
    // Explicitly expose instructions via getter to ensure it's accessible
    override get instructions() {
      return fullInstructions;
    }

    constructor() {
      super({
        instructions: fullInstructions,
        tools: {
          searchPatient: llm.tool({
            description: "Search for an existing patient by name and phone in the practice management system",
            parameters: z.object({
              firstName: z.string().describe("Patient's first name"),
              lastName: z.string().describe("Patient's last name"),
              phone: z.string().describe("Patient's phone number"),
            }),
            execute: async ({ firstName, lastName, phone }) => {
              const fullName = `${firstName} ${lastName}`;
              console.log(`[TOOL] searchPatient called: name=${fullName}, phone=${phone}`);
              if (!nexhealth) {
                return "Booking system not configured. Please call the office directly.";
              }
              try {
                // First try searching with name + phone
                let patients = await nexhealth.searchPatients({
                  name: fullName,
                  phone: phone,
                  locationId: locationId,
                });

                // If no results with phone, try name-only search (phone data often missing in sync)
                if (patients.length === 0) {
                  console.log("[TOOL] No match with phone, trying name-only search...");
                  patients = await nexhealth.searchPatients({
                    name: fullName,
                    locationId: locationId,
                  });
                }

                if (patients.length > 0) {
                  currentPatientId = patients[0]?.id as any;
                  console.log(`[TOOL] Found patient ID: ${currentPatientId}`);
                  return "Patient record found. Proceed directly to asking for appointment preference. Do not announce the patient's name.";
                }
                return "Patient not found in our system. I'll need to collect more information to create a new patient record.";
              } catch (error) {
                console.error("[TOOL] searchPatient error:", error);
                return "I had trouble searching for the patient. Please try again.";
              }
            },
          }),

          searchPatientByEmail: llm.tool({
            description: "Search for an existing patient by their registered email address",
            parameters: z.object({
              email: z.string().describe("Patient's registered email address"),
            }),
            execute: async ({ email }) => {
              console.log(`[TOOL] searchPatientByEmail called: email=${email}`);
              if (!nexhealth) {
                return "Booking system not configured. Please call the office directly.";
              }
              try {
                const patients = await nexhealth.searchPatients({
                  email: email,
                  locationId: locationId,
                });
                if (patients.length > 0) {
                  currentPatientId = patients[0]?.id as any;
                  console.log(`[TOOL] Found patient by email, ID: ${currentPatientId}`);
                  return "Patient record found. Proceed directly to asking for appointment preference.";
                }
                return "I couldn't find a record with that email. Let me create a new record for you.";
              } catch (error) {
                console.error("[TOOL] searchPatientByEmail error:", error);
                return "I had trouble searching. Let me create a new record for you.";
              }
            },
          }),

          createPatient: llm.tool({
            description: "Create a new patient record in the system. ALL fields are required.",
            parameters: z.object({
              firstName: z.string().describe("Patient's first name"),
              lastName: z.string().describe("Patient's last name"),
              email: z.string().describe("Patient's email address"),
              phone: z.string().describe("Patient's phone number (required)"),
              dateOfBirth: z.string().describe("Patient's date of birth in YYYY-MM-DD format (required)"),
              gender: z.enum(["male", "female", "other"]).describe("Patient's gender: male, female, or other (required)"),
            }),
            execute: async ({ firstName, lastName, email, phone, dateOfBirth, gender }) => {
              console.log(`[TOOL] createPatient called: ${firstName} ${lastName}, email=${email}, phone=${phone}, dob=${dateOfBirth}, gender=${gender}`);
              if (!nexhealth) {
                return "Booking system not configured. Please call the office directly.";
              }
              try {
                const patient = await nexhealth.createPatient({
                  firstName,
                  lastName,
                  email,
                  phone,
                  dateOfBirth,
                  gender,
                  locationId,
                });
                currentPatientId = patient.id;
                return `Great! I've created a patient record for ${firstName} ${lastName}. Now let me check our availability.`;
              } catch (error) {
                console.error("[TOOL] createPatient error:", error);
                return "I had trouble creating the patient record. Please try again or call the office directly.";
              }
            },
          }),

          getAvailableSlots: llm.tool({
            description: "Get available appointment slots. First ask user if they want today or a specific date. If no slots found, automatically search +2 days ahead.",
            parameters: z.object({
              startDate: z.string().optional().describe("Start date in YYYY-MM-DD format. Use today's date if user says 'today'"),
              daysToCheck: z.number().optional().describe("Number of days to check (default: 2)"),
            }),
            execute: async ({ startDate, daysToCheck = 2 }) => {
              try {
                // Get providers if we don't have one (still needed if we proceed to booking)
                if (!currentProviderId && nexhealth) {
                  const providers = await nexhealth.getProviders(locationId);
                  if (providers.length > 0) {
                    currentProviderId = providers[0]?.id as any;
                  }
                }

                const now = new Date();
                const getDatePart = (date: Date): string => date.toISOString().split('T')[0]!;
                const searchStartDate = startDate ?? getDatePart(now);

                console.log(`[TOOL] getAvailableSlots: checking availability for ${searchStartDate} using operating hours`);

                // Use rawHours from business config
                const rawHours = generalInfo.rawHours || {};
                const targetDate = new Date(searchStartDate + 'T12:00:00'); // Midday to avoid timezone shifting
                const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
                const dayName = days[targetDate.getDay()] || 'monday';
                const hoursForDay = rawHours[dayName];

                if (!hoursForDay || hoursForDay.toLowerCase() === 'closed') {
                  return `We are closed on ${searchStartDate} (${dayName}). Please check another day.`;
                }

                // Return general availability based on operating hours
                return `We are open on ${searchStartDate} (${dayName}) from ${hoursForDay}. You can request any time within these hours.`;

              } catch (error) {
                console.error("[TOOL] getAvailableSlots error:", error);
                return "I'm having trouble checking availability right now. Please try again.";
              }
            },
          }),

          bookAppointment: llm.tool({
            description: "Book an appointment for the patient",
            parameters: z.object({
              startTime: z.string().describe("Appointment start time in ISO format"),
              reason: z.string().optional().describe("Reason for the appointment"),
            }),
            execute: async ({ startTime, reason }) => {
              console.log(`[TOOL] bookAppointment called: time=${startTime}, patientId=${currentPatientId}`);
              if (!nexhealth) {
                return "Booking system not configured. Please call the office directly.";
              }
              try {
                if (!currentPatientId) {
                  return "I need to have your patient information first. Can you give me your name and email?";
                }
                if (!currentProviderId) {
                  // Try to get a provider
                  const providers = await nexhealth.getProviders(locationId);
                  if (providers.length > 0) {
                    currentProviderId = providers[0]?.id as any;
                  } else {
                    return "I couldn't find an available provider. Please call the office directly.";
                  }
                }

                const appointment = await nexhealth.createAppointment({
                  locationId,
                  patientId: currentPatientId,
                  providerId: currentProviderId as any,
                  startTime,
                  note: reason,
                });

                const appointmentDate = new Date(startTime);
                const formattedDate = appointmentDate.toLocaleDateString("en-US", {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                });
                const formattedTime = appointmentDate.toLocaleTimeString("en-US", {
                  hour: "numeric",
                  minute: "2-digit",
                  hour12: true,
                });

                return `Your appointment is confirmed for ${formattedDate} at ${formattedTime}. You'll receive a confirmation email shortly.`;
              } catch (error) {
                console.error("[TOOL] bookAppointment error:", error);
                return "I'm having trouble booking right now. Please try again or call the office directly.";
              }
            },
          }),

          getPracticeInfo: llm.tool({
            description: "Get information about the practice",
            parameters: z.object({
              infoType: z.string().describe("Type of information (hours, location, services, contact, noShowFee)"),
            }),
            execute: async ({ infoType }) => {
              const info: Record<string, string> = {
                hours: generalInfo.hours,
                location: generalInfo.address,
                services: generalInfo.services,
                contact: generalInfo.phone,
                noshowfee: `$${generalInfo.noShowFee}`,
              };
              return info[infoType.toLowerCase()] || JSON.stringify(generalInfo);
            },
          }),
        },
      });
    }
  };
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    console.log("[Agent] Prewarm starting...");
    try {
      proc.userData.vad = await silero.VAD.load({
        minSpeechDuration: 0.05,      // 50ms minimum speech
        minSilenceDuration: 0.5,      // 500ms silence to end speech (down from default 2000ms)
        prefixPaddingDuration: 0.3,   // 300ms padding before speech
        activationThreshold: 0.5,     // Balanced sensitivity
      });
      console.log("[Agent] Prewarm complete - VAD loaded");
    } catch (error) {
      console.error("[Agent] Prewarm failed:", error);
      throw error;
    }
  },
  entry: async (ctx: JobContext) => {
    console.log("[Agent] ========== ENTRY FUNCTION CALLED ==========");
    try {
      console.log("[Agent] Entry called, connecting to room...");
      await ctx.connect();
      console.log("[Agent] Connected to room");

      // Get business ID from room metadata
      let businessId: string | undefined;
      try {
        const metadata = ctx.room.metadata ? JSON.parse(ctx.room.metadata) : {};
        businessId = metadata.businessId;
        console.log("Room metadata businessId:", businessId);
      } catch {
        console.log("No room metadata found, using default business");
      }

      // Load business config
      console.log("[Agent] Loading business config...");
      const config = await loadBusinessConfig(businessId);
      if (!config) {
        console.error("No business config found!");
        return;
      }

      console.log("Using business config:", config.name);

      // Validate agent config before creating agent
      if (!config.agentConfig.agentName || !config.agentConfig.greeting) {
        console.error("Agent not properly configured! Missing agentName or greeting.");
        return;
      }

      console.log("[Agent] Creating agent session...");
      console.log("[Agent] Using voice:", config.agentConfig.voice);
      const vad = ctx.proc.userData.vad! as silero.VAD;
      const DynamicAgent = createDynamicAgent(config);

      // Use standard STT-LLM-TTS pipeline for full control over conversation flow
      // STT uses LiveKit Cloud Inference (no separate API key needed)
      const session = new voice.AgentSession({
        vad,
        stt: new inference.STT({
          model: "deepgram/nova-2-general",
          language: "en",
        }),
        llm: new google.LLM({
          model: "gemini-2.0-flash-exp",
        }),
        tts: new google.beta.TTS({
          model: "gemini-2.5-flash-preview-tts",
          voiceName: config.agentConfig.voice || "Puck",
        }),
      });

      console.log("[Agent] Starting session...");
      await session.start({
        agent: new DynamicAgent(),
        room: ctx.room,
      });

      console.log(`[Agent] Session started, sending greeting: "${config.agentConfig.greeting}"`);
      // Send the greeting immediately using TTS
      await session.say(config.agentConfig.greeting);
      console.log("[Agent] Agent ready!");
    } catch (error) {
      console.error("[Agent] Fatal error in entry:", error);
    }
  },
});

cli.runApp(
  new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    initializeProcessTimeout: 60000, // 60 seconds - increased to prevent timeout when loading VAD model
  })
);
