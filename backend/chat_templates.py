"""รูปแบบ chat template ตามตระกูลโมเดล สำหรับ Modelfile ของ Ollama

ปัญหาเดิม: เทรนด้วยรูปแบบหนึ่ง แต่ Ollama ใช้อีกรูปแบบ → โมเดลตอบแย่กว่าที่ควร
แนวทาง: ตอนเทรนใช้ tokenizer.apply_chat_template ของโมเดลฐาน (ดู jobs.py)
ตอนสร้าง Modelfile ใช้ TEMPLATE และ stop token ของตระกูลเดียวกัน (ไฟล์นี้)
และถ้า Unsloth เขียน Modelfile มาให้ข้างไฟล์ GGUF ก็ใช้ TEMPLATE จากไฟล์นั้นก่อน
"""
from __future__ import annotations

import re
from pathlib import Path

# เทมเพลต Go-template ของ Ollama ต่อตระกูล
_TEMPLATES: dict[str, dict] = {
    "llama3": {
        "template": (
            '{{ if .System }}<|start_header_id|>system<|end_header_id|>\n\n{{ .System }}<|eot_id|>{{ end }}'
            '{{ if .Prompt }}<|start_header_id|>user<|end_header_id|>\n\n{{ .Prompt }}<|eot_id|>{{ end }}'
            '<|start_header_id|>assistant<|end_header_id|>\n\n{{ .Response }}<|eot_id|>'
        ),
        "stops": ["<|eot_id|>", "<|end_of_text|>"],
    },
    "chatml": {  # Qwen และตระกูลที่ใช้ ChatML
        "template": (
            '{{ if .System }}<|im_start|>system\n{{ .System }}<|im_end|>\n{{ end }}'
            '{{ if .Prompt }}<|im_start|>user\n{{ .Prompt }}<|im_end|>\n{{ end }}'
            '<|im_start|>assistant\n{{ .Response }}<|im_end|>\n'
        ),
        "stops": ["<|im_end|>", "<|im_start|>"],
    },
    "gemma": {
        "template": (
            '{{ if .System }}<start_of_turn>user\n{{ .System }}\n\n{{ end }}'
            '{{ if and (not .System) .Prompt }}<start_of_turn>user\n{{ end }}'
            '{{ .Prompt }}<end_of_turn>\n<start_of_turn>model\n{{ .Response }}<end_of_turn>\n'
        ),
        "stops": ["<end_of_turn>", "<start_of_turn>"],
    },
}


def detect_family(model_id: str) -> str:
    """เดาตระกูลโมเดลจากชื่อ (เช่น scb10x/llama3.1-typhoon2-8b → llama3)"""
    m = (model_id or "").lower()
    if "qwen" in m:
        return "chatml"
    if "gemma" in m:
        return "gemma"
    if "llama" in m or "typhoon" in m or "mistral" in m:
        return "llama3" if "mistral" not in m else "chatml"
    return "llama3"


def family_info(model_id: str) -> dict:
    fam = detect_family(model_id)
    return {"family": fam, **_TEMPLATES[fam]}


def parse_unsloth_modelfile(path: Path) -> dict:
    """อ่าน Modelfile ที่ Unsloth สร้าง (ถ้ามี) เพื่อดึง TEMPLATE และ stop ออกมาใช้ซ้ำ
    คืน {} ถ้าไม่มี/อ่านไม่ได้ ผู้เรียกจะถอยไปใช้เทมเพลตตามตระกูลแทน"""
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {}
    out: dict = {}
    m = re.search(r'TEMPLATE\s+"""(.*?)"""', text, re.S)
    if m:
        out["template"] = m.group(1)
    stops = re.findall(r'PARAMETER\s+stop\s+"([^"]+)"', text)
    if stops:
        out["stops"] = stops
    return out


def find_unsloth_modelfile(gguf_path: Path) -> Path | None:
    """หา Modelfile ที่อยู่ข้างไฟล์ GGUF (Unsloth เขียนไว้ในโฟลเดอร์เดียวกัน)"""
    folder = Path(gguf_path).parent
    for name in ("Modelfile", "modelfile"):
        p = folder / name
        if p.exists():
            return p
    return None


def build_modelfile(gguf_path: str, base_model_id: str, system_prompt: str,
                    temperature: float = 0.7, num_ctx: int = 4096, family: str | None = None) -> str:
    """สร้างข้อความ Modelfile: FROM + TEMPLATE + SYSTEM + PARAMETER
    ลำดับความสำคัญของ TEMPLATE: ของ Unsloth (ข้างไฟล์ GGUF) → ตามตระกูลโมเดล
    family = บังคับตระกูล (เช่น "gemma" สำหรับงานที่เทรนด้วยรูปแบบเดิม) ถ้าบังคับจะไม่ใช้ template ของ Unsloth"""
    info = {"family": family, **_TEMPLATES[family]} if family else family_info(base_model_id)
    template, stops = info["template"], info["stops"]
    mf = None if family else find_unsloth_modelfile(Path(gguf_path))
    if mf:
        parsed = parse_unsloth_modelfile(mf)
        template = parsed.get("template") or template
        stops = parsed.get("stops") or stops
    safe_system = (system_prompt or "").replace('"""', "'''")
    lines = [f"FROM {gguf_path}"]
    lines.append(f'TEMPLATE """{template}"""')
    if safe_system.strip():
        lines.append(f'SYSTEM """{safe_system}"""')
    lines.append(f"PARAMETER temperature {temperature}")
    lines.append(f"PARAMETER num_ctx {num_ctx}")
    for s in stops:
        lines.append(f'PARAMETER stop "{s}"')
    return "\n".join(lines) + "\n"
