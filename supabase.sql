-- Supabase → SQL Editor 에 붙여넣고 Run

-- 1) 논문 / 아이디어 저장 테이블 (본인 데이터만 보이도록 RLS)
create table if not exists public.items (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null,
  kind text not null check (kind in ('paper', 'idea')),
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
alter table public.items enable row level security;
create policy "own items" on public.items
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 2) 스크린샷 저장소 (비공개 버킷, <user_id>/파일 경로만 본인 접근 가능)
insert into storage.buckets (id, name, public) values ('images', 'images', false)
  on conflict (id) do nothing;
create policy "own images read" on storage.objects for select to authenticated
  using (bucket_id = 'images' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own images write" on storage.objects for insert to authenticated
  with check (bucket_id = 'images' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own images delete" on storage.objects for delete to authenticated
  using (bucket_id = 'images' and (storage.foldername(name))[1] = auth.uid()::text);
