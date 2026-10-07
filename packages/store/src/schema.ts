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
    parent_session_id text,
    agent_name text,
    agent_path text,
    agent_policy_json text,
    created_at integer not null,
    updated_at integer not null
  )`,
  `create index if not exists sessions_updated_idx on sessions(updated_at)`,
  `create unique index if not exists sessions_agent_name on sessions(parent_session_id, agent_name) where parent_session_id is not null`,

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
    created_event_seq integer not null
  )`,
  `create index if not exists messages_session_time_idx on messages(session_id, created_at, id)`,
  `create index if not exists messages_turn_idx on messages(turn_id)`,
  `create index if not exists messages_session_created_seq_idx on messages(session_id, created_event_seq, created_at, id)`,

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

  `create table if not exists session_creation_claims (
    session_id text primary key,
    claim_id text not null unique,
    cwd text not null,
    claimed_at integer not null,
    heartbeat_at integer not null,
    lease_expires_at integer not null
  )`,
  `create table if not exists session_run_claims (
    session_id text primary key,
    claim_id text not null unique,
    claimed_at integer not null,
    heartbeat_at integer not null,
    lease_expires_at integer not null
  )`,
  `create table if not exists session_dispatch (
    session_id text primary key references sessions(id),
    paused integer not null default 0,
    revision integer not null default 0
  )`,
  `create table if not exists session_inputs (
    sequence integer primary key autoincrement,
    input_id text not null unique,
    submission_id text not null,
    session_id text not null references sessions(id),
    mode text not null,
    state text not null,
    revision integer not null default 1,
    payload text not null,
    identity text not null,
    text text not null,
    source text not null,
    accepted_at integer not null,
    updated_at integer not null,
    settled_revision integer not null default 0,
    claim_id text,
    execution_ref text,
    message_id text,
    turn_id text,
    outcome text,
    error text,
    result_message_id text,
    resumed integer not null default 0,
    unique(session_id, submission_id)
  )`,
  `create index if not exists session_inputs_pending on session_inputs(session_id, state, sequence)`,
  `create table if not exists session_input_revocations (
    session_id text not null,
    source text not null,
    primary key(session_id, source)
  )`,
];
