import { createLogger } from '../lib/logger';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { WorkspaceSupabaseDatabaseConfig } from '../context/workspace-config.types';
import type {
  ChatMessageDto,
  ConversationDto,
  ConversationStatus,
  GeneratedTestDto,
  MessageRole,
  MessageType,
  TestFlowStep,
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

type GeneratedTestRow = {
  id: string;
  conversation_id: string;
  workspace_path: string;
  test_name: string | null;
  language: string;
  framework: string;
  code: string;
  version: number;
  status: string;
  created_at: string;
  updated_at: string;
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
      conversationId: string;
      role: MessageRole;
      content: string;
      messageType: MessageType;
      metadata?: Record<string, unknown>;
    },
  ): Promise<ChatMessageDto> {
    const { data, error } = await this.table(database, 'conversation_messages')
      .insert({
        conversation_id: input.conversationId,
        role: input.role,
        content: input.content,
        message_type: input.messageType,
        metadata: input.metadata ?? {},
      })
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

  async saveGeneratedTest(
    database: WorkspaceSupabaseDatabaseConfig,
    input: {
      conversationId: string;
      workspacePath: string;
      testName: string | null;
      language: string;
      framework: string;
      code: string;
    },
  ): Promise<GeneratedTestDto> {
    const { data, error } = await this.table(database, 'generated_tests')
      .insert({
        conversation_id: input.conversationId,
        workspace_path: input.workspacePath,
        test_name: input.testName,
        language: input.language,
        framework: input.framework,
        code: input.code,
        status: 'generated',
      })
      .select('*')
      .single();

    if (error || !data) {
      throw new Error(`Supabase saveGeneratedTest failed: ${error?.message}`);
    }
    return this.mapGeneratedTest(data as GeneratedTestRow);
  }

  async getLatestGeneratedTest(
    database: WorkspaceSupabaseDatabaseConfig,
    conversationId: string,
  ): Promise<GeneratedTestDto | null> {
    const { data, error } = await this.table(database, 'generated_tests')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error(
        `Supabase getLatestGeneratedTest failed: ${error.message}`,
      );
    }
    if (!data) {
      return null;
    }
    return this.mapGeneratedTest(data as GeneratedTestRow);
  }

  extractApprovedTestFlow(messages: ChatMessageDto[]): TestFlowStep[] | null {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (msg.messageType !== 'test_proposal') {
        continue;
      }
      const flow = msg.metadata?.testFlow;
      if (Array.isArray(flow) && flow.length > 0) {
        return flow as TestFlowStep[];
      }
    }
    return null;
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

  private mapGeneratedTest(row: GeneratedTestRow): GeneratedTestDto {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      workspacePath: row.workspace_path,
      testName: row.test_name,
      language: row.language,
      framework: row.framework,
      code: row.code,
      version: row.version,
      status: row.status,
      createdAt: row.created_at,
    };
  }
}
