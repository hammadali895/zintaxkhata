create table if not exists public.khata_users (
    id bigint generated always as identity primary key,
    username text not null unique check (
        username ~ '^[a-z0-9._-]{3,32}$'
    ),
    password_hash text not null,
    created_at timestamptz not null default now()
);

create table if not exists public.khata_data (
    user_id bigint not null references public.khata_users(id) on delete cascade,
    collection text not null check (
        collection in ('customers', 'transactions', 'products', 'sales', 'settings')
    ),
    records jsonb not null default '[]'::jsonb check (
        jsonb_typeof(records) = 'array'
    ),
    primary key (user_id, collection)
);

create table if not exists public.khata_sessions (
    token_hash text primary key,
    user_id bigint not null references public.khata_users(id) on delete cascade,
    csrf_token text not null,
    expires_at timestamptz not null
);

create index if not exists khata_sessions_expires_at_idx
    on public.khata_sessions (expires_at);

alter table public.khata_users enable row level security;
alter table public.khata_data enable row level security;
alter table public.khata_sessions enable row level security;
