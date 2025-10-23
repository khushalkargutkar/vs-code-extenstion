import os
import subprocess
import sys

def create_or_reuse_venv():
    """Create a virtual environment if it doesn't exist, or reuse an existing one."""
    venv_path = os.path.join(os.getcwd(), ".venv")
    if not os.path.exists(venv_path):
        print("Creating virtual environment...")
        subprocess.check_call([sys.executable, "-m", "venv", venv_path])
        print("Virtual environment created.")
    else:
        print("Reusing existing virtual environment.")
    return venv_path

def install_pre_commit(venv_path):
    """Install pre-commit inside the virtual environment."""
    pip_executable = os.path.join(venv_path, "Scripts", "pip")
    pre_commit_executable = os.path.join(venv_path, "Scripts", "pre-commit")

    print("Installing pre-commit...")
    subprocess.check_call([pip_executable, "install", "pre-commit"])
    print("Pre-commit installed.")

    print("Installing pre-commit hooks...")
    subprocess.check_call([pre_commit_executable, "install"])
    print("Pre-commit hooks installed.")

def main():
    try:
        venv_path = create_or_reuse_venv()
        install_pre_commit(venv_path)
        print("Pre-commit setup completed successfully.")
    except Exception as e:
        print(f"Error during pre-commit setup: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()