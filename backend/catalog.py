"""Static catalog of recommended base models and datasets.

This mirrors the recommendations in thai-local-llm-guide.md so the UI
doesn't need a second source of truth to keep in sync by hand.
"""

BASE_MODELS = [
    {
        "id": "scb10x/llama3.2-typhoon2-3b-instruct",
        "label": "Typhoon2 3B Instruct",
        "params": "3B",
        "vramFitGb": 4,
        "notes": "เบาสุด เหมาะกับการ์ด 4GB ทดลองง่าย เทรนได้จริงบนเครื่องนี้",
        "recommended": True,
    },
    {
        "id": "scb10x/llama3.1-typhoon2-8b-instruct",
        "label": "Typhoon2 8B Instruct",
        "params": "8B",
        "vramFitGb": 6,
        "notes": "ใช้ inference ได้บนเครื่องนี้ แต่เทรนไม่ไหว ต้องใช้ Colab/cloud",
        "recommended": False,
    },
    {
        "id": "Qwen/Qwen2.5-7B-Instruct",
        "label": "Qwen2.5 7B Instruct",
        "params": "7B",
        "vramFitGb": 12,
        "notes": "ต้องเทรนบน Colab (T4 16GB) แล้วค่อยเอา GGUF กลับมารัน inference ในเครื่อง",
        "recommended": False,
    },
]

DATASETS = [
    {
        "id": "Thaweewat/alpaca-cleaned-52k-th",
        "label": "Alpaca Cleaned (Thai, 52k)",
        "sizeHint": "52,000 ตัวอย่าง",
        "notes": "ชุดข้อมูลทั่วไป เหมาะเป็นจุดเริ่มต้นก่อนทำโดเมนเฉพาะทาง",
    },
    {
        "id": "airesearch/WangchanThaiInstruct",
        "label": "WangchanThaiInstruct",
        "sizeHint": "หลายหมื่นตัวอย่าง",
        "notes": "ชุดข้อมูลสอน instruction ภาษาไทยจาก VISTEC",
    },
    {
        "id": "databricks-dolly-15k-th",
        "label": "Dolly 15k (Thai)",
        "sizeHint": "15,000 ตัวอย่าง",
        "notes": "แปลจาก Dolly ของ Databricks เหมาะทดลองเร็วๆ",
    },
]
