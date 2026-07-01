#!/usr/bin/env python3
# Injects a resident "serve-stdio" mode into upstream diffusion-cli.cpp so a parent
# process (diffusion_shim.py) can expose an OpenAI-compatible HTTP API without the
# 16 GB model reloading per request. Idempotent: bails if the marker is already present.
#
# Protocol (length-prefixed, newline-safe):
#   Request  : "REQ <n_msgs>\n" then per message "<role> <byte_len>\n<content bytes>\n"
#   Response : "RESP <byte_len>\n<content bytes>\n"   (flushed)
# The engine prints "READY\n" on stdout once the model is loaded; all model/log noise
# goes to stderr. Generation reuses the file's existing run_turn/apply_template/make_msg.
import sys

PATH = sys.argv[1] if len(sys.argv) > 1 else "examples/diffusion/diffusion-cli.cpp"

with open(PATH, "r") as f:
    src = f.read()

if "DIFFUSION_SERVE_STDIO" in src:
    sys.stderr.write("[inject] serve mode already present; skipping\n")
    sys.exit(0)

# 1) ensure <cstdlib> for getenv/strtol/atoi
if "#include <cstdlib>" not in src:
    src = src.replace("#include <vector>\n", "#include <vector>\n#include <cstdlib>\n", 1)

# 1a) full nlohmann json (chat.h only pulls in json_fwd.hpp; we need ::parse for
# common_chat_tools_parse_oaicompat). llama-common exposes this include dir.
if 'nlohmann/json.hpp' not in src:
    src = src.replace('#include "chat.h"\n', '#include "chat.h"\n#include "nlohmann/json.hpp"\n', 1)

# 1b) enable_thinking control — the shim sets DIFFUSION_ENABLE_THINKING to keep the
# model's channel-thought reasoning; unset (default) disables it for much lower latency.
APPLY_MARK = "        inputs.add_generation_prompt = true;\n"
if APPLY_MARK in src:
    src = src.replace(
        APPLY_MARK,
        APPLY_MARK
        + "        inputs.enable_thinking       = (getenv(\"DIFFUSION_ENABLE_THINKING\") != nullptr);\n"
        + "        // Tool router: declare the compacted tools the shim forwarded so the template\n"
        + "        // renders them and the model can emit <|tool_call>. json::parse FIRST (the fn takes\n"
        + "        // nlohmann::ordered_json&, a raw std::string throws), and keep our OWN try/catch so a\n"
        + "        // bad/unsupported tools JSON leaves inputs.tools empty (no-op) instead of blanking the reply.\n"
        + "        if (!g_serve_tools_json.empty()) {\n"
        + "            try {\n"
        + "                inputs.tools = common_chat_tools_parse_oaicompat(nlohmann::ordered_json::parse(g_serve_tools_json));\n"
        + "                inputs.tool_choice = COMMON_CHAT_TOOL_CHOICE_AUTO;\n"
        + "            } catch (...) { /* leave tools empty */ }\n"
        + "        }\n",
        1,
    )
else:
    sys.stderr.write("[inject] ERROR: could not find add_generation_prompt marker\n")
    sys.exit(1)

# 1c) In serve mode, detokenize WITH special tokens so the shim sees the tool-call and
# channel markers (<|tool_call>, <tool_call|>, <|\"|>, <|channel>) instead of them being
# stripped. Interactive/one-shot modes keep the clean (false) rendering.
RUN_TURN_MARK = "    auto run_turn = [&](const std::string & formatted_prompt) -> std::string {"
if RUN_TURN_MARK not in src:
    sys.stderr.write("[inject] ERROR: could not find run_turn marker\n")
    sys.exit(1)
src = src.replace(
    RUN_TURN_MARK,
    "    const bool g_render_special = (getenv(\"DIFFUSION_SERVE_STDIO\") != nullptr);\n"
    "    std::string g_serve_tools_json;  // per-request compacted OpenAI tools JSON (serve mode)\n" + RUN_TURN_MARK,
    1,
)
src = src.replace("output_tokens.begin() + n_generated), false);",
                  "output_tokens.begin() + n_generated), g_render_special);", 1)
src = src.replace("return common_detokenize(vocab, response, false);",
                  "return common_detokenize(vocab, response, g_render_special);", 1)

SERVE_BLOCK = r'''    // ---- Resident serve-stdio mode (ModelServer OpenAI shim) --------------------------------
    // With DIFFUSION_SERVE_STDIO set: load once, then serve requests over a length-prefixed
    // stdin/stdout protocol. Stateless per request (the shim sends the full message list each
    // time). Calls run_turn() directly (not run_turn_reply) so stdout stays clean for the
    // protocol; model/timing logs go to stderr.
    if (getenv("DIFFUSION_SERVE_STDIO")) {
        fprintf(stderr, "diffusion serve-stdio: model loaded, ready\n");
        fflush(stderr);
        fprintf(stdout, "READY\n");
        fflush(stdout);
        std::string line;
        while (std::getline(std::cin, line)) {
            if (line.rfind("REQ ", 0) != 0) {
                continue;
            }
            const int n_msgs = atoi(line.c_str() + 4);
            // Optional 2nd int on the REQ line = tools-frame byte length (0/absent
            // when the shim sends no tools -> byte-identical to the old protocol).
            long tools_len = 0;
            {
                const char * p = line.c_str() + 4;
                char * endp = nullptr;
                strtol(p, &endp, 10);              // n_msgs (already parsed)
                if (endp) tools_len = strtol(endp, nullptr, 10);
            }
            std::vector<common_chat_msg> messages;
            bool ok = true;
            for (int i = 0; i < n_msgs; i++) {
                std::string hdr;
                if (!std::getline(std::cin, hdr)) { ok = false; break; }
                const size_t sp = hdr.rfind(' ');
                if (sp == std::string::npos) { ok = false; break; }
                const std::string role = hdr.substr(0, sp);
                const long len = strtol(hdr.c_str() + sp + 1, nullptr, 10);
                std::string content;
                if (len > 0) {
                    content.resize((size_t) len);
                    std::cin.read(&content[0], len);
                }
                std::cin.get();  // consume the trailing newline
                messages.push_back(make_msg(role, content));
            }
            if (!ok) { break; }
            g_serve_tools_json.clear();
            if (tools_len > 0) {
                g_serve_tools_json.resize((size_t) tools_len);
                std::cin.read(&g_serve_tools_json[0], tools_len);
                std::cin.get();  // consume the trailing newline
            }
            std::string response;
            try {
                response = run_turn(apply_template(messages));
            } catch (...) {
                response = "";
            }
            fprintf(stdout, "RESP %zu\n", response.size());
            if (!response.empty()) { fwrite(response.data(), 1, response.size(), stdout); }
            fprintf(stdout, "\n");
            fflush(stdout);
        }
        llama_free(ctx);
        llama_model_free(model);
        llama_backend_free();
        return 0;
    }
    // ----------------------------------------------------------------------------------------

'''

MARKER = "    if (params.conversation_mode == COMMON_CONVERSATION_MODE_ENABLED) {"
if MARKER not in src:
    sys.stderr.write("[inject] ERROR: could not find conversation_mode marker\n")
    sys.exit(1)

src = src.replace(MARKER, SERVE_BLOCK + MARKER, 1)

with open(PATH, "w") as f:
    f.write(src)
sys.stderr.write("[inject] serve-stdio mode injected\n")
