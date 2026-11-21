FROM python:3.12-slim
WORKDIR /app
COPY index.html meeting.js server.py meeting_workflow.py meeting_export.py model_config.py sei_directory.json ./
COPY assets/meeting-room-overhead.svg ./assets/
ENV PORT=8765
EXPOSE 8765
CMD ["python", "server.py"]
