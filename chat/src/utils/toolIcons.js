// One icon per tool, shared by the tool-call chips, the working-notes bar and
// the "N tool calls" bar so a tool looks the same everywhere.
import {
    Globe, FileText, FileEdit, Code2, Terminal, Search, FolderOpen, FolderSearch, GitBranch, BarChart3,
    Image as ImageIcon, Camera, Film, Download, Archive, ListOrdered, ArrowLeftRight, BookOpen, Bug, ScanText,
    Mic, Users, Workflow, Shield, Wrench, Database, FileSpreadsheet, Link as LinkIcon, Mail, Package, Binary, Lightbulb,
} from 'lucide-react';

const RULES = [
    [/^thinking$/, Lightbulb],
    [/^(first_pass|ask_assistant|await_assistant|escalate)$/, ArrowLeftRight],
    [/^(web|web_search|fetch_url|scrapling_fetch|playwright_fetch|playwright_interact|crawl_pages|sniff_media_streams|http_request)$/, Globe],
    [/^take_screenshot$|^screenshot$/, Camera],
    [/^(find_image|transform_image|convert_image|image_info)$/, ImageIcon],
    [/^ocr_image$/, ScanText],
    [/^(find_video|download_video|analyze_video)$/, Film],
    [/^transcribe_audio$/, Mic],
    [/^(render_chart|chart_plot|fetch_timeseries)$/, BarChart3],
    [/^count_entries$/, ListOrdered],
    [/^(run_python|run_node|run_npm|save_tool)$/, Code2],
    [/^(run_bash|run_powershell|run_cmd|bash|powershell|sandbox_bash|shell_\w+|ssh_connect)$/, Terminal],
    [/^(grep_code|search_files|find)$/, Search],
    [/^(scan_source_files|outline_file)$/, FolderSearch],
    [/^(list_directory|ls|workspace_list)$/, FolderOpen],
    [/^(create_file|append_to_file|replace_lines|write|edit|move_file|copy_file)$/, FileEdit],
    [/^(read_file|head_file|tail_file|read|get_file_metadata|read_pdf|create_pdf|html_to_pdf|create_docx|read_docx|markdown_to_html)$/, FileText],
    [/^(read_xlsx|create_xlsx|csv_describe|spreadsheet_query)$/, FileSpreadsheet],
    [/^(query_sqlite|workspace_db)$/, Database],
    [/^git_/, GitBranch],
    [/^(extract_archive|tar_extract|unzip_file)$/, Archive],
    [/^(download_file|download_html|download_vsix|make_downloadable|workspace_get|workspace_put)$/, Download],
    [/^(extract_strings|hex_dump|hex_convert|xor_bytes|base64_decode|binary_info)$/, Binary],
    [/^(disassemble|decompile|gdb_batch|unpack_upx|inspect_msi)$/, Bug],
    [/^(virustotal_lookup|dns_lookup|whois_lookup|yara_scan|analyze_pe)$/, Shield],
    [/^(read_email_file|create_email|send_file)$/, Mail],
    [/^load_skill$/, BookOpen],
    [/^delegate$/, Users],
    [/^build_automation$/, Workflow],
    [/^(npm_|pip_)/, Package],
    [/^(url|link)/, LinkIcon],
];

export function iconForTool(name) {
    const n = String(name || '');
    for (const [re, Icon] of RULES) if (re.test(n)) return Icon;
    return Wrench;
}

// Distinct tools in first-use order (for the bundled icon stack).
export function distinctTools(calls) {
    const seen = [];
    for (const c of Array.isArray(calls) ? calls : []) {
        const n = c && (c.label || c.name);
        if (n && !seen.includes(n)) seen.push(n);
    }
    return seen;
}
