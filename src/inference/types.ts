export interface InferenceClient { decide(prompt: string): Promise<{ text: string }> }
export interface RelayConfig { baseUrl: string; apiKey: string; model: string }
