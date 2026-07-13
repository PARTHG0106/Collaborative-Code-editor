import gradio as gr
import spaces
import subprocess
import os
import sys
import tempfile
import uuid

# Restrict to 60 seconds
@spaces.GPU(duration=60)
def execute_job(code: str, language: str):
    if language != "python":
        return {"error": "GPU worker currently only supports Python execution.", "exitCode": 1}

    # Write code to a temp file
    temp_dir = tempfile.mkdtemp()
    file_path = os.path.join(temp_dir, f"script_{uuid.uuid4().hex}.py")
    
    with open(file_path, "w") as f:
        f.write(code)

    try:
        # Run python code
        result = subprocess.run(
            [sys.executable, file_path],
            capture_output=True,
            text=True,
            timeout=58 # slightly less than 60s
        )
        return {
            "stdout": result.stdout,
            "stderr": result.stderr,
            "exitCode": result.returncode
        }
    except subprocess.TimeoutExpired:
        return {
            "stdout": "",
            "stderr": "GPU execution limit exceeded (60 seconds).",
            "exitCode": 1
        }
    except Exception as e:
        return {
            "stdout": "",
            "stderr": str(e),
            "exitCode": 1
        }

with gr.Blocks() as app:
    gr.Markdown("# SyncScript GPU Execution Worker")
    code_input = gr.Code(language="python")
    lang_input = gr.Textbox(value="python")
    output = gr.JSON()
    btn = gr.Button("Execute")
    
    btn.click(execute_job, inputs=[code_input, lang_input], outputs=output, api_name="execute")

app.launch(server_name="0.0.0.0", server_port=7860)
