#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
# Add-on options (/data/options.json) -> /data/config.json + env, then the HTTP server.
# The key and the token go only into the environment of the server process, never
# into config.json or the log.
set -e

OPTIONS=/data/options.json
CONFIG=/data/config.json

opt() { jq -r "${1} // empty" "${OPTIONS}"; }

LOG_LEVEL="$(opt .log_level)"
bashio::log.level "${LOG_LEVEL:-info}"

TOKEN="$(opt .http_token)"
if [ "${#TOKEN}" -lt 32 ]; then
    bashio::exit.nok "http_token must be at least 32 characters (for example: openssl rand -hex 32)"
fi
KEY="$(opt .openrouter_key)"
if [ -z "${KEY}" ]; then
    bashio::log.warning "openrouter_key is empty: every model call fails until it is set"
fi

PRICE_IN="$(opt .max_price_usd_per_mtok.in)"
PRICE_OUT="$(opt .max_price_usd_per_mtok.out)"
if [ -n "${PRICE_IN}${PRICE_OUT}" ] && { [ -z "${PRICE_IN}" ] || [ -z "${PRICE_OUT}" ]; }; then
    bashio::log.warning "max_price_usd_per_mtok needs both in and out; the price cap is off"
fi

# models[] {alias, ids "a, b", reasoning none|low|default} -> models{alias: {ids[], params}}.
# export_dir set -> it is also the only write root; empty -> export off.
jq '
  def idlist: split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0));
  def params(r): if r == "none" or r == "low" then {params: {reasoning: {effort: r}}} else {} end;
  def nonempty: . != null and . != "";
  {
    read_roots: .read_roots,
    models: ((.models // []) | map({key: .alias, value: ({ids: (.ids | idlist)} + params(.reasoning))}) | from_entries),
    defaults: ((.defaults // {}) | with_entries(select(.value | nonempty))),
    daily_budget_usd: .daily_budget_usd,
    results_retention_days: .results_retention_days,
    export_retention_days: .export_retention_days,
    time: {default_tz: (if (.time_default_tz | nonempty) then .time_default_tz else "UTC" end)},
    url_input: (if .url_input == false then false else true end)
  }
  + (if (.max_price_usd_per_mtok.in != null) and (.max_price_usd_per_mtok.out != null)
     then {max_price_usd_per_mtok: {in: .max_price_usd_per_mtok.in, out: .max_price_usd_per_mtok.out}} else {} end)
  + (if (.export_dir | nonempty) then {write_roots: [.export_dir], export_dir: .export_dir} else {} end)
  + (if (.url_contact | nonempty) then {url_contact: .url_contact} else {} end)
' "${OPTIONS}" > "${CONFIG}"

export CHEAP_EYES_CONFIG="${CONFIG}"
export CHEAP_EYES_STATE_DIR=/data
export CHEAP_EYES_OPENROUTER_KEY="${KEY}"
export CHEAP_EYES_HTTP_TOKEN="${TOKEN}"

# No proxy unless the user sets one. The URL may carry credentials: never logged.
PROXY="$(opt .https_proxy)"
if [ -n "${PROXY}" ]; then
    export HTTPS_PROXY="${PROXY}"
    export NODE_USE_ENV_PROXY=1
    bashio::log.info "outbound HTTPS (OpenRouter, https:// URLs) goes through the configured proxy"
fi

# debug/trace: print the resolved settings (no secrets) before starting.
case "${LOG_LEVEL}" in
    debug | trace) cheap-eyes check-config || true ;;
esac

bashio::log.info "starting cheap-eyes on port 3400"
exec cheap-eyes serve --http --host 0.0.0.0 --port 3400
