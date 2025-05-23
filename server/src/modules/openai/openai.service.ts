import { AzureOpenAI, OpenAI } from "openai";
import * as dotenv from "dotenv";

dotenv.config();

type ServiceProvider = "openai" | "azure";
type ResponseFormat = "string" | "json";

interface TokenUsage {
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
}

interface OpenAIResponseData {
  content: string | Record<string, any>;
  token_usage: TokenUsage;
  model: string;
  response_format: ResponseFormat;
}

class OpenAIResponse implements OpenAIResponseData {
  content: string | Record<string, any>;
  token_usage: TokenUsage;
  model: string;
  response_format: ResponseFormat;

  constructor(data: OpenAIResponseData) {
    this.content = data.content;
    this.token_usage = data.token_usage;
    this.model = data.model;
    this.response_format = data.response_format;
  }

  toJSON(): OpenAIResponseData {
    return {
      content: this.content,
      token_usage: this.token_usage,
      model: this.model,
      response_format: this.response_format,
    };
  }
}

interface OpenAIWrapperConfig {
  apiKey?: string;
  serviceProvider?: ServiceProvider;
  maxRetries?: number;
}

interface BaseMessage {
  role: "system" | "user" | "assistant" | "tool";
  tool_call_id?: string;
  name?: string;
}

interface ContentMessage extends BaseMessage {
  content: string;
}

type ChatMessage = ContentMessage | (BaseMessage & { content?: string });

interface ChatToolMessage {
  role: "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
}

export class OpenAIWrapper {
  private client: OpenAI;
  private readonly maxRetries: number;
  private readonly serviceProvider: ServiceProvider;

  constructor(config: OpenAIWrapperConfig = {}) {
    const { serviceProvider = "azure", maxRetries = 3 } = config;

    this.maxRetries = maxRetries;
    this.serviceProvider = serviceProvider;

    if (serviceProvider === "openai") {
      const apiKey = process.env.OPENAI_API_KEY;

      if (!apiKey) {
        throw new Error("OPENAPI key is required. Set it in environment");
      }

      this.client = new OpenAI({ apiKey });
    } else if (serviceProvider === "azure") {
      const apiKey = process.env.AZURE_OPENAI_API_KEY;

      if (!apiKey) {
        throw new Error("AZURE OPENAI key is required. Set it in environment");
      }

      this.client = new AzureOpenAI({
        apiKey: apiKey || "",
        endpoint: process.env.AZURE_OPENAI_ENDPOINT || "",
        deployment: process.env.AZURE_OPENAI_DEPLOYMENT_NAME || "",
      });
    } else {
      throw new Error("Invalid service provider. Choose 'openai' or 'azure'.");
    }
  }

  private async retryApiCall<T>(
    func: () => Promise<T>,
    maxAttempts: number = this.maxRetries,
  ): Promise<T> {
    let attempts = 0;
    while (attempts < maxAttempts) {
      try {
        return await func();
      } catch (error) {
        attempts++;
        if (attempts >= maxAttempts) {
          throw error;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.pow(2, attempts) * 1000),
        );
      }
    }
    throw new Error(`Failed after ${maxAttempts} attempts`);
  }

  async generateResponse(
    userPrompt: string,
    systemPrompt?: string,
    options: {
      model?: string;
      maxTokens?: number;
      temperature?: number;
      outputFormat?: ResponseFormat;
    } = {},
  ): Promise<OpenAIResponseData> {
    const {
      model = "gpt-4o-mini",
      maxTokens = 1000,
      temperature = 0.7,
      outputFormat = "string",
    } = options;

    let retryCount = 0;
    while (retryCount < this.maxRetries) {
      try {
        let content = "";
        let messages: any = [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ];

        const response = await this.retryApiCall(async () => {
          return await this.client.chat.completions.create({
            model,
            messages,
            max_tokens: maxTokens,
            temperature,
            response_format:
              outputFormat === "json" ? { type: "json_object" } : undefined,
          });
        });

        const response_message = response.choices[0].message;

        if (response_message.tool_calls) {
          messages.push(response_message);

          for (let tool_call of response_message.tool_calls) {
            if (tool_call.function.name == "") {
              const function_args = JSON.parse(tool_call.function.arguments);
              console.log("Function args: ", function_args);
              const tool_response = "";
              messages.push({
                tool_call_id: tool_call.id,
                role: "tool",
                name: "",
                content: tool_response,
              });
            }
          }

          const finalResponse = await this.retryApiCall(async () => {
            return await this.client.chat.completions.create({
              model,
              messages,
              max_tokens: maxTokens,
              temperature,
              response_format:
                outputFormat === "json" ? { type: "json_object" } : undefined,
            });
          });

          content = finalResponse.choices[0].message.content || "";
        } else {
          content = response.choices[0].message.content || "";
        }

        if (outputFormat === "json") {
          content = content.replace(/```json\n?|\n?```/g, "").trim();
          try {
            content = JSON.parse(content);
          } catch (error) {
            retryCount++;
            if (retryCount >= this.maxRetries) {
              throw new Error(
                `Failed to parse response as JSON after ${this.maxRetries} retries.`,
              );
            }
            continue;
          }
        }

        const tokenUsage: TokenUsage = {
          total_tokens: response.usage?.total_tokens || 0,
          prompt_tokens: response.usage?.prompt_tokens || 0,
          completion_tokens: response.usage?.completion_tokens || 0,
        };

        return new OpenAIResponse({
          content,
          token_usage: tokenUsage,
          model,
          response_format: outputFormat,
        }).toJSON();
      } catch (error) {
        retryCount++;
        if (retryCount >= this.maxRetries) {
          throw new Error(
            `Failed to generate a valid response after ${this.maxRetries} retries.`,
          );
        }
        console.error(`API call failed with error: ${error}. Retrying...`);
        await new Promise((resolve) =>
          setTimeout(resolve, Math.pow(2, retryCount) * 1000),
        );
      }
    }

    throw new Error("Failed to generate response");
  }

  async generateChatResponse(
    messages: any[],
    options: {
      model?: string;
      maxTokens?: number;
      temperature?: number;
      outputFormat?: ResponseFormat;
      tools?: any[];
    } = {},
  ): Promise<OpenAIResponseData> {
    const {
      model = "gpt-4o-mini",
      maxTokens = 1000,
      temperature = 0.7,
      outputFormat = "string",
      tools = [],
    } = options;

    let retryCount = 0;
    while (retryCount < this.maxRetries) {
      try {
        let content = "";
        const response = await this.retryApiCall(async () => {
          return await this.client.chat.completions.create({
            model,
            messages,
            max_tokens: maxTokens,
            temperature,
            response_format:
              outputFormat === "json" ? { type: "json_object" } : undefined,
            tools: tools.map((tool: any) => tool.toolDefinition),
            tool_choice: "auto",
          });
        });

        const response_message = response.choices[0].message;

        if (response_message.tool_calls) {
          messages.push(response_message);

          for (let tool_call of response_message.tool_calls) {
            const allTools = tools.map((tool) => tool.name);
            if (allTools.includes(tool_call.function.name)) {
              const tool = tools.find(
                (t) => t.name === tool_call.function.name,
              );
              const function_args = JSON.parse(tool_call.function.arguments);
              console.log("Function args: ", function_args);
              const tool_response = tool.functionDefinition(
                ...Object.values(function_args),
              );
              messages.push({
                tool_call_id: tool_call.id,
                role: "tool",
                name: tool.name,
                content: tool_response,
              });
            }
          }

          const finalResponse = await this.retryApiCall(async () => {
            return await this.client.chat.completions.create({
              model,
              messages,
              max_tokens: maxTokens,
              temperature,
              response_format:
                outputFormat === "json" ? { type: "json_object" } : undefined,
            });
          });

          content = finalResponse.choices[0].message.content || "";
        } else {
          content = response.choices[0].message.content || "";
        }

        const tokenUsage: TokenUsage = {
          total_tokens: response.usage?.total_tokens || 0,
          prompt_tokens: response.usage?.prompt_tokens || 0,
          completion_tokens: response.usage?.completion_tokens || 0,
        };

        return new OpenAIResponse({
          content,
          token_usage: tokenUsage,
          model,
          response_format: outputFormat,
        }).toJSON();
      } catch (error) {
        retryCount++;
        if (retryCount >= this.maxRetries) {
          throw new Error(
            `Failed to generate a valid response after ${this.maxRetries} retries.`,
          );
        }
        console.error(`API call failed with error: ${error}. Retrying...`);
        await new Promise((resolve) =>
          setTimeout(resolve, Math.pow(2, retryCount) * 1000),
        );
      }
    }

    throw new Error("Failed to generate response");
  }
}
