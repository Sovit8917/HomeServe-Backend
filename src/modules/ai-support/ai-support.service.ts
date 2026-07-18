import {
  Injectable,
  Logger,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

export interface AiChatTurn {
  role: 'user' | 'model';
  text: string;
}

const SYSTEM_INSTRUCTION = `You are HomeServe's in-app support assistant. HomeServe is a home services
marketplace app (plumbing, electrical, AC repair, cleaning, etc.) connecting customers with
verified workers.

Rules:
- Be concise, warm, and practical. Prefer short answers over long paragraphs.
- Help with: booking questions, tracking a worker, payment/refund questions, rescheduling,
  cancellations, subscription plans, and general how-to-use-the-app questions.
- You cannot look up a specific user's actual booking, payment, or account data — you don't have
  access to their account. If they ask something that requires that (e.g. "where is my worker",
  "why was I charged X"), tell them you can't pull up their specific record, and suggest they tap
  "Talk to a human" so a support agent with account access can help — don't guess or make up
  booking details, statuses, or amounts.
- If the user seems frustrated, upset, wants a refund dispute, reports a safety concern, or
  explicitly asks for a human, proactively suggest escalating to a human agent.
- Never invent policies, prices, or refund amounts you're not certain of.`;

@Injectable()
export class AiSupportService {
  private readonly logger = new Logger(AiSupportService.name);
  private readonly apiKey: string;
  private readonly model: string;

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
  ) {
    this.apiKey = this.config.get<string>('GEMINI_API_KEY', '');
    this.model = this.config.get<string>('GEMINI_MODEL', 'gemini-2.5-flash');
  }

  async chat(message: string, history: AiChatTurn[] = []) {
    if (!message?.trim()) {
      throw new BadRequestException('Message cannot be empty');
    }
    if (!this.apiKey) {
      throw new ServiceUnavailableException('AI support is not configured');
    }

    // Cap history sent per request — keeps latency/cost bounded and this
    // is support chat, not a long-running conversation that needs deep
    // context. The client still keeps the full transcript for escalation.
    const recentHistory = history.slice(-20);

    const contents = [
      ...recentHistory.map((turn) => ({
        role: turn.role,
        parts: [{ text: turn.text }],
      })),
      { role: 'user', parts: [{ text: message }] },
    ];

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
          contents,
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 512,
          },
        }),
      });
    } catch (err: any) {
      this.logger.error(`Gemini request failed: ${err?.message}`);
      throw new ServiceUnavailableException(
        'AI support is temporarily unavailable, please try again',
      );
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      this.logger.error(`Gemini API error ${response.status}: ${errBody}`);
      throw new ServiceUnavailableException(
        'AI support is temporarily unavailable, please try again',
      );
    }

    const data: any = await response.json();
    const reply: string | undefined =
      data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!reply) {
      // Most commonly a safety-filter block (finishReason: 'SAFETY' etc.)
      this.logger.warn(
        `Gemini returned no text. finishReason=${data?.candidates?.[0]?.finishReason}`,
      );
      return {
        data: {
          reply:
            "Sorry, I couldn't answer that one. Would you like to talk to a human instead?",
          suggestEscalation: true,
        },
      };
    }

    const suggestEscalation =
      /talk to a human|human agent|support agent|escalat/i.test(reply);

    return { data: { reply, suggestEscalation } };
  }

  /**
   * Converts the AI conversation transcript into a real SupportTicket +
   * TicketMessage history, so a human agent picks up with full context
   * instead of the customer having to re-explain everything. Reuses the
   * existing support-ticket chat screen/endpoints on both app and admin
   * side — no new UI surface needed for the human-handoff part.
   */
  async escalate(
    userId: string,
    history: AiChatTurn[],
    subject = 'AI Chat Escalation',
  ) {
    if (!history?.length) {
      throw new BadRequestException('No conversation to escalate');
    }

    const description =
      history.find((t) => t.role === 'user')?.text?.slice(0, 500) ??
      'Escalated from AI chat';

    const ticket = await this.prisma.supportTicket.create({
      data: { subject, description, userId },
    });

    await this.prisma.ticketMessage.createMany({
      data: history.map((turn) => ({
        ticketId: ticket.id,
        senderId: turn.role === 'user' ? userId : 'ai-assistant',
        senderType: turn.role === 'user' ? 'USER' : 'AI',
        message: turn.text,
      })),
    });

    return {
      message: 'Connecting you to a human agent',
      data: { ticketId: ticket.id },
    };
  }
}
