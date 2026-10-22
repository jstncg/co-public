create or replace function public.hybrid_search_artifact_segments(
  p_user_id uuid,
  p_query_text text,
  p_query_embedding extensions.vector(1536),
  p_match_count integer default 20
) returns table (
  segment_id uuid,
  artifact_id uuid,
  segment_text text,
  lexical_score real,
  semantic_score real,
  combined_score real
)
language sql
stable
security definer
set search_path = ''
as $$
  with ranked as (
    select
      segment.id as segment_id,
      segment.artifact_id,
      segment.text as segment_text,
      ts_rank_cd(to_tsvector('english', segment.text), websearch_to_tsquery('english', p_query_text))::real as lexical_score,
      (1 - (segment.embedding OPERATOR(extensions.<=>) p_query_embedding))::real as semantic_score
    from public.artifact_segments segment
    join public.artifacts artifact on artifact.id = segment.artifact_id
    where segment.user_id = p_user_id
      and artifact.user_id = p_user_id
      and artifact.deleted_at is null
      and segment.embedding is not null
  )
  select ranked.segment_id, ranked.artifact_id, ranked.segment_text,
    ranked.lexical_score, ranked.semantic_score,
    (0.35 * ranked.lexical_score + 0.65 * ranked.semantic_score)::real as combined_score
  from ranked
  order by combined_score desc
  limit least(greatest(p_match_count, 1), 100);
$$;

revoke all on function public.hybrid_search_artifact_segments(uuid, text, extensions.vector, integer) from public, anon, authenticated;
grant execute on function public.hybrid_search_artifact_segments(uuid, text, extensions.vector, integer) to service_role;
