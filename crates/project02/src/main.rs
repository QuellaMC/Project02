fn main() -> std::process::ExitCode {
    project02::run(&std::env::args_os().skip(1).collect::<Vec<_>>())
}
