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
    if language not in ["python", "cpp", "c"]:
        return {"error": f"GPU worker currently does not support {language} execution.", "exitCode": 1}

    temp_dir = tempfile.mkdtemp()
    
    try:
        if language == "python":
            file_path = os.path.join(temp_dir, f"script_{uuid.uuid4().hex}.py")
            with open(file_path, "w") as f:
                f.write(code)
                
            result = subprocess.run(
                [sys.executable, file_path],
                capture_output=True,
                text=True,
                timeout=58
            )
            return {
                "stdout": result.stdout,
                "stderr": result.stderr,
                "exitCode": result.returncode
            }
            
        elif language in ["cpp", "c"]:
            ext = "cpp" if language == "cpp" else "c"
            compiler = "g++" if language == "cpp" else "gcc"
            
            source_file = os.path.join(temp_dir, f"main.{ext}")
            out_file = os.path.join(temp_dir, "main.out")
            
            with open(source_file, "w") as f:
                f.write(code)
                
            # Compile
            compile_result = subprocess.run(
                [compiler, source_file, "-o", out_file],
                capture_output=True,
                text=True,
                timeout=20
            )
            
            if compile_result.returncode != 0:
                return {
                    "stdout": compile_result.stdout,
                    "stderr": compile_result.stderr,
                    "exitCode": compile_result.returncode
                }
                
            # Execute
            run_result = subprocess.run(
                [out_file],
                capture_output=True,
                text=True,
                timeout=38
            )
            return {
                "stdout": run_result.stdout,
                "stderr": run_result.stderr,
                "exitCode": run_result.returncode
            }
            
    except subprocess.TimeoutExpired:
        return {
            "stdout": "",
            "stderr": "GPU execution limit exceeded.",
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

app.launch(server_name="0.0.0.0", server_port=7860, share=True)
