#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
# App options (/data/options.json) -> /data/config.json + env, the token, then the
# HTTP server. The key and the token go only into the environment of the server
# process or /data/token, never into config.json; the token is shown in the log once,
# when it is generated.
set -e

OPTIONS=/data/options.json
CONFIG=/data/config.json

opt() { jq -r "${1} // empty" "${OPTIONS}"; }

LOG_LEVEL="$(opt .log_level)"
bashio::log.level "${LOG_LEVEL:-info}"

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
# No models -> no defaults either (they would name aliases that do not exist): the
# server then picks models itself on the first job and pins the pick in /data.
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
  | if (.models | length) == 0 then del(.defaults) else . end
' "${OPTIONS}" > "${CONFIG}"

# The container name, for the commands the log suggests on the host.
SLUG=$(hostname 2>/dev/null | tr '-' '_' || true)

# The server reads the pin on every job: with the file gone, the next job picks again.
# Every command here ends in "|| true", so a broken pin file cannot stop the start.
PIN=/data/models.json
if [ "$(jq '.models | length' "${CONFIG}")" = "0" ]; then
    if [ -f "${PIN}" ]; then
        # Empty unless the file holds what the server needs: picked_at and a non-empty
        # list of id strings.
        PINNED=$(jq -r 'select(type == "object" and (.picked_at | type) == "string" and (.ids | type) == "array" and (.ids | length) > 0 and all(.ids[]; type == "string" and . != "")) | "\(.ids | join(", ")) (picked \(.picked_at))"' "${PIN}" 2>/dev/null || true)
        if [ -n "${PINNED}" ]; then
            bashio::log.info "models: none in the options; the models pinned in ${PIN} are in use: ${PINNED}. To pick again: on the host, docker exec app_${SLUG} rm ${PIN} (container addon_${SLUG} with an older Supervisor), then the next job picks; or name models in the options"
        else
            bashio::log.warning "models: none in the options; the pin file ${PIN} cannot be used (not JSON, or no picked_at and ids in it): the next job sets it aside and picks again"
        fi
    else
        bashio::log.info "models: none in the options; models are picked on the first job and pinned in /data (see the documentation)"
    fi
fi

export CHEAP_EYES_CONFIG="${CONFIG}"
export CHEAP_EYES_STATE_DIR=/data
export CHEAP_EYES_OPENROUTER_KEY="${KEY}"
export CHEAP_EYES_SETTINGS_UI="the app options in Home Assistant"

# No proxy unless the user sets one. The URL may carry credentials: never logged.
PROXY="$(opt .https_proxy)"
if [ -n "${PROXY}" ]; then
    export HTTPS_PROXY="${PROXY}"
    export NODE_USE_ENV_PROXY=1
    bashio::log.info "outbound HTTPS (OpenRouter, https:// URLs) goes through the configured proxy"
fi

# Token. An empty option means the server's own token in /data/token: generated when
# there is none, then written into the option, so it shows on the Configuration tab.
# Any other value is used as given; the server checks it (at least 32 characters).
TOKEN=$(bashio::config 'http_token')
if [ "${TOKEN}" = "null" ]; then TOKEN=""; fi
TOKEN_FILE=/data/token
# Present once the token of /data/token is in the option: an empty option after
# that means the field was cleared for a new token. /data/token without it
# means the write into the option failed: the token is kept and the write is
# tried again.
TOKEN_SAVED=/data/.token-in-option

# Through the Supervisor API (/addons/self/options needs no extra role),
# checked by reading the option back: the return code of bashio::addon.option
# does not carry the API result.
save_token_option() {
    bashio::addon.option 'http_token' "${1}" > /dev/null || true
    [ "$(bashio::addon.options | jq -r '.http_token // empty')" = "${1}" ]
}

if [ -n "${TOKEN}" ]; then
    export CHEAP_EYES_HTTP_TOKEN="${TOKEN}"
else
    if [ -f "${TOKEN_FILE}" ] && [ ! -f "${TOKEN_SAVED}" ]; then
        bashio::log.info "token: using ${TOKEN_FILE}, not in the http_token option yet"
    else
        if [ -f "${TOKEN_SAVED}" ]; then
            bashio::log.warning "token: the http_token option was cleared: a new token replaces the old one, so the connector URL changes: update it in every client"
        fi
        # Generated by cheap-eyes (32 random bytes, mode 0600). stdout: the
        # connector path, then the Bearer line; shown here once.
        if ! LINES=$(cheap-eyes token --new 2>/tmp/cheap-eyes-token.err); then
            bashio::log.error "token: $(cat /tmp/cheap-eyes-token.err)"
            bashio::exit.nok
        fi
        rm -f "${TOKEN_SAVED}"
        bashio::log.info "token: new token generated and saved to ${TOKEN_FILE}"
        bashio::log.info "claude.ai connector path: ${LINES%%$'\n'*}"
        bashio::log.info "Bearer header: ${LINES#*$'\n'}"
    fi
    if save_token_option "$(cat "${TOKEN_FILE}")"; then
        touch "${TOKEN_SAVED}"
        bashio::log.info "token: saved in the http_token option (Configuration tab)"
    else
        bashio::log.warning "token: the http_token option could not be written; the token stays in ${TOKEN_FILE} and is used from there, and the next start tries again. To show it, on the host: docker exec app_${SLUG} env CHEAP_EYES_STATE_DIR=/data cheap-eyes token (container addon_${SLUG} with an older Supervisor)"
    fi
fi

# debug/trace: print the resolved settings (no secrets) before starting.
case "${LOG_LEVEL}" in
    debug | trace) cheap-eyes check-config || true ;;
esac

bashio::log.info "starting cheap-eyes on port 3400"
exec cheap-eyes serve --http --host 0.0.0.0 --port 3400
