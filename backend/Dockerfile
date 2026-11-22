FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# 给目录写权限，确保 SQLite 数据库可以正常读写
RUN chmod -R 777 /app

# Hugging Face Spaces 默认固定使用 7860 端口
EXPOSE 7860

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7860"]