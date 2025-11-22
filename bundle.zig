const std = @import("std");

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const ally = gpa.allocator();

    const stderr_file = std.io.getStdErr();
    var stderr = stderr_file.writer();

    const stdout = std.io.getStdOut();
    var out = stdout.writer();

    var args = try std.process.argsWithAllocator(ally);
    defer args.deinit();

    var skip_n_args: usize = 1;

    while (args.next()) |key| {
        if (skip_n_args > 0) {
            skip_n_args -= 1;
            continue;
        }

        const path = args.next() orelse {
            try stderr.print("No path specified for key '{s}'\n", .{key});
            return error.MissingPath;
        };

        var enc = std.base64.standard.Encoder;
        var file = try std.fs.cwd().openFile(path, .{});
        defer file.close();

        const stat = try file.stat();
        const enc_size = enc.calcSize(stat.size);
        const content = try file.readToEndAlloc(ally, stat.size);
        defer ally.free(content);

        const base64_buffer = try ally.alloc(u8, enc_size);
        defer ally.free(base64_buffer);
        const final_base64 = enc.encode(base64_buffer, content);

        try out.print("window[\"{s}\"] = \"{s}\";\n", .{
            key,
            final_base64,
        });
    }
}
