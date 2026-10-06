export const SQLITE_SCHEMA = [
  `create table if not exists events (
    seq integer primary key autoincrement,
    id text not null unique,
    type text not null,
    time integer not null,
    session_id text,
    payload_json text not null
  )`,
  `create unique index if not exists events_id_idx on events(id)`,
  `create index if not exists events_seq_idx on events(seq)`,
  `create index if not exists events_session_seq_idx on events(session_id, seq)`,
  `create index if not exists events_session_type_seq_idx on events(session_id, type, seq)`,
  `create index if not exists events_type_seq_idx on events(type, seq)`,
  `create index if not exists events_session_time_idx on events(session_id, time, id)`,
  `create index if not exists events_type_time_idx on events(type, time, id)`,

  `create table if not exists sessions (
    id text primary key,
    cwd text not null,
    title text,
    status text not null,
    read_only integer not null default 0,
    created_at integer not null,
    updated_at integer not null
  )`,
  `create index if not exists sessions_updated_idx on sessions(updated_at)`,

  `create table if not exists session_goals (
    session_id text not null primary key,
    objective text not null,
    status text not null,
    token_budget integer,
    tokens_used integer not null default 0,
    time_used_seconds real not null default 0,
    created_at integer not null,
    updated_at integer not null,
    completed_at integer,
    last_reason text
  )`,
  `create index if not exists session_goals_status_idx on session_goals(status, updated_at)`,

  `create table if not exists messages (
    id text primary key,
    session_id text not null,
    turn_id text,
    role text not null,
    parent_id text,
    created_at integer not null,
    created_event_seq integer
  )`,
  `create index if not exists messages_session_time_idx on messages(session_id, created_at, id)`,

  `create table if not exists message_parts (
    id text primary key,
    message_id text not null,
    session_id text not null,
    type text not null,
    ordinal integer not null,
    data_json text not null,
    delta_event_seq integer not null default 0,
    created_at integer not null
  )`,
  `create index if not exists message_parts_message_ordinal_idx on message_parts(message_id, ordinal)`,
  `create index if not exists message_parts_session_idx on message_parts(session_id)`,

  `create table if not exists tool_calls (
    id text primary key,
    provider_call_id text,
    parent_call_id text,
    session_id text,
    turn_id text,
    tool_name text not null,
    status text not null,
    input_json text,
    output text,
    error text,
    synthetic integer not null default 0,
    started_at integer not null,
    updated_at integer not null
  )`,
  `create index if not exists tool_calls_session_status_idx on tool_calls(session_id, status)`,
  `create index if not exists tool_calls_turn_idx on tool_calls(turn_id)`,
  `create index if not exists tool_calls_parent_idx on tool_calls(parent_call_id)`,

  `create table if not exists approvals (
    id text primary key,
    session_id text,
    call_id text,
    permission text not null,
    patterns_json text not null,
    max_approval_scope text,
    metadata_json text,
    status text not null,
    decision text,
    feedback text,
    created_at integer not null,
    resolved_at integer
  )`,
  `create index if not exists approvals_session_status_idx on approvals(session_id, status)`,
  `create index if not exists approvals_call_idx on approvals(call_id)`,

];
