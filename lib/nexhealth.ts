/**
 * NexHealth Synchronizer API Client
 * Used for appointment booking with OpenDental integration
 * API Docs: https://docs.nexhealth.com/reference
 */

interface NexHealthConfig {
    apiKey: string;
    subdomain: string;
    baseUrl?: string;
}

interface Patient {
    id: number;
    first_name: string;
    last_name: string;
    email: string | null;
    phone?: string;
    date_of_birth?: string;
    bio?: {
        phone_number?: string;
        cell_phone_number?: string;
        home_phone_number?: string;
        work_phone_number?: string;
        date_of_birth?: string;
        gender?: string;
        city?: string;
        state?: string;
        zip_code?: string;
        address_line_1?: string;
        address_line_2?: string;
    };
}

interface Provider {
    id: number;
    first_name: string;
    last_name: string;
    speciality?: string;
}

interface Location {
    id: number;
    name: string;
    address?: string;
    phone?: string;
}

interface AppointmentSlot {
    time: string; // ISO format
    provider_id: number;
    operatory_id?: number;
}

interface Appointment {
    id: number;
    patient_id: number;
    provider_id: number;
    location_id: number;
    start_time: string;
    end_time: string;
    status: string;
    appointment_type_id?: number;
}

interface AppointmentType {
    id: number;
    name: string;
    duration: number;
}

export class NexHealthClient {
    private apiKey: string;
    private subdomain: string;
    private baseUrl: string;
    private bearerToken: string | null = null;
    private tokenExpiry: Date | null = null;

    constructor(config: NexHealthConfig) {
        this.apiKey = config.apiKey;
        this.subdomain = config.subdomain;
        this.baseUrl = config.baseUrl || "https://nexhealth.info";
    }

    /**
     * Authenticate and get bearer token
     * Auth endpoint only needs API key in Authorization header
     * Subdomain is used in subsequent API calls
     */
    async authenticate(): Promise<string> {
        // Check if we have a valid token
        if (this.bearerToken && this.tokenExpiry && new Date() < this.tokenExpiry) {
            return this.bearerToken;
        }

        console.log("[NexHealth] Authenticating with API key...");

        const response = await fetch(`${this.baseUrl}/authenticates`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/vnd.Nexhealth+json;version=2",
                Authorization: this.apiKey,
            },
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error("[NexHealth] Authentication failed:", response.status, errorText);
            throw new Error(`Authentication failed: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        console.log("[NexHealth] Authentication successful");
        this.bearerToken = data.data?.token || data.token;
        // Token is valid for 1 hour in production, 24 hours in sandbox
        this.tokenExpiry = new Date(Date.now() + 55 * 60 * 1000); // 55 minutes to be safe

        return this.bearerToken!;
    }

    private async request<T>(
        endpoint: string,
        options: RequestInit = {}
    ): Promise<T> {
        const token = await this.authenticate();

        const url = `${this.baseUrl}${endpoint}`;
        console.log(`[NexHealth] ${options.method || 'GET'} ${endpoint}`);

        const response = await fetch(url, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                Accept: "application/vnd.Nexhealth+json;version=2",
                Authorization: `Bearer ${token}`,
                ...options.headers,
            },
        });

        if (!response.ok) {
            const error = await response.text();
            console.error(`[NexHealth] API error: ${response.status} - ${error}`);
            throw new Error(`NexHealth API error: ${response.status} - ${error}`);
        }

        const data = await response.json();
        console.log(`[NexHealth] Response OK`);
        return data;
    }

    /**
     * Get all locations for the practice
     */
    async getLocations(): Promise<Location[]> {
        const data = await this.request<{ data: Location[] }>(
            `/locations?subdomain=${this.subdomain}`
        );
        return data.data;
    }

    /**
     * Get providers for a location
     */
    async getProviders(locationId: number): Promise<Provider[]> {
        const data = await this.request<{ data: Provider[] }>(
            `/providers?subdomain=${this.subdomain}&location_id=${locationId}`
        );
        return data.data;
    }

    /**
     * Get appointment types
     */
    async getAppointmentTypes(locationId: number): Promise<AppointmentType[]> {
        const data = await this.request<{ data: AppointmentType[] }>(
            `/appointment_types?subdomain=${this.subdomain}&location_id=${locationId}`
        );
        return data.data;
    }

    /**
     * Search for existing patients by name, email, and/or phone
     * NexHealth recommends providing multiple fields for accurate matching
     */
    async searchPatients(params: {
        name?: string;
        email?: string;
        phone?: string;
        locationId: number;
    }): Promise<Patient[]> {
        let url = `/patients?subdomain=${this.subdomain}&location_id=${params.locationId}`;

        if (params.name) {
            url += `&name=${encodeURIComponent(params.name)}`;
        }
        if (params.email) {
            url += `&email=${encodeURIComponent(params.email)}`;
        }
        if (params.phone) {
            url += `&phone=${encodeURIComponent(params.phone)}`;
        }

        const response = await this.request<{ data: { patients?: Patient[] } | Patient[] }>(url);
        // Handle nested structure: response may be { data: { patients: [...] } } or { data: [...] }
        const data = response.data;
        if (Array.isArray(data)) {
            return data;
        }
        return data?.patients || [];
    }

    /**
     * Create a new patient
     */
    async createPatient(patient: {
        firstName: string;
        lastName: string;
        email: string;
        phone: string;
        dateOfBirth: string;
        gender: string;
        locationId: number;
    }): Promise<Patient> {
        const data = await this.request<{ data: Patient }>(`/patients`, {
            method: "POST",
            body: JSON.stringify({
                subdomain: this.subdomain,
                location_id: patient.locationId,
                patient: {
                    first_name: patient.firstName,
                    last_name: patient.lastName,
                    email: patient.email,
                    phone: patient.phone,
                    date_of_birth: patient.dateOfBirth,
                    gender: patient.gender,
                },
            }),
        });
        return data.data;
    }

    /**
     * Get available appointment slots
     */
    async getAppointmentSlots(params: {
        locationId: number;
        providerId?: number | undefined;
        appointmentTypeId?: number | undefined;
        startDate: string; // YYYY-MM-DD
        endDate: string; // YYYY-MM-DD
        daysOfWeek?: number[] | undefined; // 0-6 (Sunday-Saturday)
    }): Promise<AppointmentSlot[]> {
        // NexHealth uses 'days' for number of days ahead, and 'lids'/'pids' for location/provider IDs
        // Calculate days from startDate to endDate
        const start = new Date(params.startDate);
        const end = new Date(params.endDate);
        const days = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;

        let url = `/appointment_slots?subdomain=${this.subdomain}`;
        url += `&start_date=${params.startDate}`;
        url += `&days=${days}`;
        url += `&lids[]=${params.locationId}`;  // lids = location IDs array

        if (params.providerId) {
            url += `&pids[]=${params.providerId}`;  // pids = provider IDs array
        }
        if (params.appointmentTypeId) {
            url += `&appointment_type_id=${params.appointmentTypeId}`;
        }

        const response = await this.request<{ data: { slots?: AppointmentSlot[] } | AppointmentSlot[] }>(url);
        // Handle nested structure
        const data = response.data;
        if (Array.isArray(data)) {
            return data;
        }
        return data?.slots || [];
    }

    /**
     * Create an appointment
     */
    async createAppointment(params: {
        locationId: number;
        patientId: number;
        providerId: number;
        startTime: string; // ISO format
        appointmentTypeId?: number | undefined;
        operatoryId?: number | undefined;
        note?: string | undefined;
    }): Promise<Appointment> {
        const data = await this.request<{ data: Appointment }>(`/appointments`, {
            method: "POST",
            body: JSON.stringify({
                subdomain: this.subdomain,
                location_id: params.locationId,
                appointment: {
                    patient_id: params.patientId,
                    provider_id: params.providerId,
                    start_time: params.startTime,
                    appointment_type_id: params.appointmentTypeId,
                    operatory_id: params.operatoryId,
                    note: params.note,
                },
            }),
        });
        return data.data;
    }

    /**
     * Cancel an appointment
     */
    async cancelAppointment(appointmentId: number): Promise<void> {
        await this.request(`/appointments/${appointmentId}`, {
            method: "DELETE",
            body: JSON.stringify({
                subdomain: this.subdomain,
            }),
        });
    }

    /**
     * Get patient by ID
     */
    async getPatient(patientId: number): Promise<Patient> {
        const data = await this.request<{ data: Patient }>(
            `/patients/${patientId}?subdomain=${this.subdomain}`
        );
        return data.data;
    }
}

/**
 * Format available slots for voice agent
 */
export function formatSlotsForAgent(slots: AppointmentSlot[]): string {
    if (slots.length === 0) {
        return "No available slots found for the requested time period.";
    }

    // Group by date
    const slotsByDate = slots.reduce(
        (acc, slot) => {
            // Parse the time string - it should be ISO format
            const slotDate = new Date(slot.time);

            // Check if date is valid
            if (isNaN(slotDate.getTime())) {
                console.error(`[formatSlots] Invalid date: ${slot.time}`);
                return acc;
            }

            const date = slotDate.toLocaleDateString("en-US", {
                weekday: "long",
                month: "long",
                day: "numeric",
            });

            if (!acc[date]) {
                acc[date] = [];
            }

            acc[date].push(
                slotDate.toLocaleTimeString("en-US", {
                    hour: "numeric",
                    minute: "2-digit",
                    hour12: true,
                })
            );
            return acc;
        },
        {} as Record<string, string[]>
    );

    // Format for speech
    const formatted = Object.entries(slotsByDate)
        .slice(0, 3) // Limit to 3 days for voice
        .map(([date, times]) => {
            const timesStr = times.slice(0, 4).join(", "); // Limit to 4 times per day
            return `${date}: ${timesStr}`;
        })
        .join(". ");

    return formatted;
}
