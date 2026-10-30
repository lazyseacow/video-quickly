#[cfg(not(test))]
fn main() -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let out_dir = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("缺少构建输出目录"));
        prepare_sidecar_resource(&out_dir)?;
    }
    tauri_build::build();
    Ok(())
}

#[cfg(unix)]
fn prepare_sidecar_resource(out_dir: &std::path::Path) -> std::io::Result<()> {
    let target = out_dir.ancestors().nth(3).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "构建输出目录结构无效")
    })?;
    let node = target.join("sidecar/node");
    let metadata = match std::fs::symlink_metadata(&node) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    // Tauri preserves Homebrew Node's read-only mode when copying resources.
    // Replace only the generated file; never follow a link to the system Node.
    if metadata.is_file() && metadata.permissions().readonly() {
        std::fs::remove_file(node)?;
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::prepare_sidecar_resource;
    use std::{
        fs,
        os::unix::fs::{symlink, PermissionsExt},
    };

    #[test]
    fn replaces_readonly_node_copies_without_changing_the_original() {
        let directory = std::env::temp_dir().join(format!("vq-build-resource-{}", uuid::Uuid::new_v4()));
        let target = directory.join("custom-target/aarch64-apple-darwin/debug");
        let out = target.join("build/video-quickly-test/out");
        fs::create_dir_all(&out).unwrap();
        fs::create_dir_all(target.join("sidecar")).unwrap();
        let source = directory.join("original-node");
        fs::write(&source, b"original runtime").unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o555)).unwrap();
        let copied = target.join("sidecar/node");
        fs::copy(&source, &copied).unwrap();
        for _ in 0..2 {
            prepare_sidecar_resource(&out).unwrap();
            fs::copy(&source, &copied).unwrap();
            assert_eq!(fs::read(&copied).unwrap(), b"original runtime");
            assert_eq!(
                fs::metadata(&source).unwrap().permissions().mode() & 0o777,
                0o555
            );
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn preserves_writable_files_and_does_not_follow_symlinks() {
        let directory = std::env::temp_dir().join(format!("vq-build-resource-{}", uuid::Uuid::new_v4()));
        let out = directory.join("debug/build/video-quickly-test/out");
        fs::create_dir_all(&out).unwrap();
        prepare_sidecar_resource(&out).unwrap();
        fs::create_dir_all(directory.join("debug/sidecar")).unwrap();
        let copied = directory.join("debug/sidecar/node");
        fs::write(&copied, b"writable").unwrap();
        prepare_sidecar_resource(&out).unwrap();
        assert_eq!(fs::read(&copied).unwrap(), b"writable");
        fs::remove_file(&copied).unwrap();
        let source = directory.join("original-node");
        fs::write(&source, b"original").unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o555)).unwrap();
        symlink(&source, &copied).unwrap();
        prepare_sidecar_resource(&out).unwrap();
        assert!(fs::symlink_metadata(&copied).unwrap().is_symlink());
        assert_eq!(
            fs::metadata(&source).unwrap().permissions().mode() & 0o777,
            0o555
        );
        fs::remove_dir_all(directory).unwrap();
    }
}
