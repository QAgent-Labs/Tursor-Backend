import { createLogger } from '../lib/logger';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { WorkspaceSupabaseDatabaseConfig } from '../context/workspace-config.types';
import type { CdpStepDefinition } from '../cdp/cdp-step.types';
import type {
  ChatMessageDto,
  ConversationDto,
  ConversationStatus,
  MessageRole,
  MessageType,
} from './chat.types';

type ConversationRow = {
  id: string;
  workspace_path: string;
  status: string;
  title: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  message_type: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

type CdpPlanRow = {
  id: string;
  conversation_id: string;
  workspace_path: string;
  title: string | null;
  steps: CdpStepDefinition[] | null;
  created_at: string;
};

export class SupabaseChatService {
  private readonly logger = createLogger('SupabaseChatService');
  private readonly clientCache = new Map<string, SupabaseClient>();

  private getClient(database: WorkspaceSupabaseDatabaseConfig): SupabaseClient {
    const url = database.url.trim();
    const key = database.serviceRoleKey.trim();
    const cacheKey = `${url}:${key.slice(0, 16)}`;
    const cached = this.clientCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    this.clientCache.set(cacheKey, client);
    return client;
  }

  private table(database: WorkspaceSupabaseDatabaseConfig, name: string) {
    const client = this.getClient(database);
    const schema = database.schema?.trim() || 'public';
    if (schema === 'public') {
      return client.from(name);
    }
    return client.schema(schema).from(name);
  }

  async createConversation(
    database: WorkspaceSupabaseDatabaseConfig,
    workspacePath: string,
    title?: string,
  ): Promise<ConversationDto> {
    const { data, error } = await this.table(database, 'conversations')
      .insert({
        workspace_path: workspacePath,
        status: 'NORMAL',
        title: title ?? null,
        summary: '',
      })
      .select('*')
      .single();

    if (error || !data) {
      this.logger.error(`createConversation failed: ${error?.message}`);
      throw new Error(
        `Supabase createConversation failed: ${error?.message ?? 'unknown'}`,
      );
    }
    return this.mapConversation(data as ConversationRow);
  }

  async listConversations(
    database: WorkspaceSupabaseDatabaseConfig,
    workspacePath: string,
  ): Promise<ConversationDto[]> {
    const { data, error } = await this.table(database, 'conversations')
      .select('*')
      .eq('workspace_path', workspacePath)
      .order('updated_at', { ascending: false })
      .limit(50);

    if (error) {
      throw new Error(`Supabase listConversations failed: ${error.message}`);
    }
    return (data as ConversationRow[]).map((row) => this.mapConversation(row));
  }

  async getConversation(
    database: WorkspaceSupabaseDatabaseConfig,
    conversationId: string,
  ): Promise<ConversationDto | null> {
    const { data, error } = await this.table(database, 'conversations')
      .select('*')
      .eq('id', conversationId)
      .maybeSingle();

    if (error) {
      throw new Error(`Supabase getConversation failed: ${error.message}`);
    }
    if (!data) {
      return null;
    }
    return this.mapConversation(data as ConversationRow);
  }

  async updateConversationStatus(
    database: WorkspaceSupabaseDatabaseConfig,
    conversationId: string,
    status: ConversationStatus,
    summary?: string,
  ): Promise<void> {
    const patch: Record<string, unknown> = {
      status,
      updated_at: new Date().toISOString(),
    };
    if (summary !== undefined) {
      patch.summary = summary;
    }
    const { error } = await this.table(database, 'conversations')
      .update(patch)
      .eq('id', conversationId);

    if (error) {
      throw new Error(
        `Supabase updateConversationStatus failed: ${error.message}`,
      );
    }
  }

  async insertMessage(
    database: WorkspaceSupabaseDatabaseConfig,
    input: {
      id?: string;
      conversationId: string;
      role: MessageRole;
      content: string;
      messageType: MessageType;
      metadata?: Record<string, unknown>;
    },
  ): Promise<ChatMessageDto> {
    const row: Record<string, unknown> = {
      conversation_id: input.conversationId,
      role: input.role,
      content: input.content,
      message_type: input.messageType,
      metadata: input.metadata ?? {},
    };
    if (input.id) {
      row.id = input.id;
    }
    const { data, error } = await this.table(database, 'conversation_messages')
      .insert(row)
      .select('*')
      .single();

    if (error || !data) {
      throw new Error(`Supabase insertMessage failed: ${error?.message}`);
    }

    await this.table(database, 'conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', input.conversationId);

    return this.mapMessage(data as MessageRow);
  }

  async listMessages(
    database: WorkspaceSupabaseDatabaseConfig,
    conversationId: string,
    limit = 50,
  ): Promise<ChatMessageDto[]> {
    const { data, error } = await this.table(database, 'conversation_messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(limit);

    if (error) {
      throw new Error(`Supabase listMessages failed: ${error.message}`);
    }
    return (data as MessageRow[]).map((row) => this.mapMessage(row));
  }

  async updateSummary(
    database: WorkspaceSupabaseDatabaseConfig,
    conversationId: string,
    summary: string,
  ): Promise<void> {
    const { error } = await this.table(database, 'conversations')
      .update({
        summary,
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversationId);

    if (error) {
      throw new Error(`Supabase updateSummary failed: ${error.message}`);
    }
  }

  async saveCdpPlan(
    database: WorkspaceSupabaseDatabaseConfig,
    input: {
      conversationId: string;
      workspacePath: string;
      title: string;
      steps: CdpStepDefinition[];
    },
  ): Promise<{ id: string; title: string }> {
    const { data, error } = await this.table(database, 'cdp_plans')
      .insert({
        conversation_id: input.conversationId,
        workspace_path: input.workspacePath,
        title: input.title,
        steps: input.steps,
      })
      .select('id, title')
      .single();

    if (error || !data) {
      throw new Error(`Supabase saveCdpPlan failed: ${error?.message}`);
    }
    const row = data as { id: string; title: string | null };
    return { id: row.id, title: row.title ?? input.title };
  }

  async getCdpPlan(
    database: WorkspaceSupabaseDatabaseConfig,
    planId: string,
  ): Promise<{
    id: string;
    conversationId: string;
    workspacePath: string;
    title: string;
    steps: CdpStepDefinition[];
  } | null> {
    const { data, error } = await this.table(database, 'cdp_plans')
      .select('*')
      .eq('id', planId)
      .maybeSingle();

    if (error) {
      throw new Error(`Supabase getCdpPlan failed: ${error.message}`);
    }
    if (!data) {
      return null;
    }
    const row = data as CdpPlanRow;
    return {
      id: row.id,
      conversationId: row.conversation_id,
      workspacePath: row.workspace_path,
      title: row.title ?? '',
      steps: Array.isArray(row.steps) ? row.steps : [],
    };
  }

  private mapConversation(row: ConversationRow): ConversationDto {
    return {
      id: row.id,
      workspacePath: row.workspace_path,
      status: row.status as ConversationStatus,
      title: row.title,
      summary: row.summary ?? '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapMessage(row: MessageRow): ChatMessageDto {
    return {
      id: row.id,
      role: row.role as MessageRole,
      content: row.content,
      messageType: row.message_type as MessageType,
      metadata: row.metadata ?? {},
      createdAt: row.created_at,
    };
  }

}
