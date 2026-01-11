// Helper: fetch JSON with error handling
async function fetchJSON(url, opts = {}) {
  try {
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error("Fetch error:", err);
    return null;
  }
}

// Login button
document.getElementById("loginBtn").addEventListener("click", () => {
  window.location.href = "/auth/login";
});

// Load accounts and populate list + dropdown
async function loadAccounts() {
  const accounts = await fetchJSON("/api/accounts");
  const list = document.getElementById("accountsList");
  const select = document.getElementById("account");
  list.innerHTML = "";
  select.innerHTML = `<option value="">-- Select Account --</option>`;

  if (!accounts || accounts.length === 0) {
    list.innerHTML = "<div>No connected accounts. Click 'Connect Instagram' and choose a Page.</div>";
    return;
  }

  accounts.forEach(acc => {
    // Buttons
    const btn = document.createElement("button");
    btn.textContent = acc.page_name;
    btn.addEventListener("click", () => {
      select.value = acc.id;
      select.dataset.pageId = acc.page_id;
      select.dataset.pageToken = acc.page_access_token;
      showMessage(`Selected ${acc.page_name}`, "success");
    });
    list.appendChild(btn);

    // Dropdown options
    const opt = document.createElement("option");
    opt.value = acc.id;
    opt.textContent = acc.page_name;
    select.appendChild(opt);
  });
}

// Show messages
function showMessage(msg, type = "success") {
  const messageBox = document.getElementById("message");
  messageBox.textContent = msg;
  messageBox.style.color = type === "success" ? "green" : "red";
  setTimeout(() => { messageBox.textContent = ""; }, 5000);
}

// Schedule post
document.getElementById("postForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const select = document.getElementById("account");
  const ig_account_id = select.value;
  const page_id = select.dataset.pageId;
  const page_access_token = select.dataset.pageToken;

  const caption = document.getElementById("caption").value.trim();
  const media = document.getElementById("media").value.trim();
  const time = document.getElementById("time").value;

  if (!caption || !media || !time) {
    showMessage("Please fill all fields", "error");
    return;
  }

  const res = await fetch("/api/schedule", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ig_account_id,
      page_id,
      page_name: select.options[select.selectedIndex].text,
      caption,
      media_url: media,
      scheduled_time: new Date(time).toISOString(),
      page_access_token
    }),
  });

  const data = await res.json();
  if (res.ok) {
    showMessage("Scheduled successfully!");
    document.getElementById("postForm").reset();
    loadPosts();
  } else {
    showMessage(data.error || "Failed to schedule", "error");
  }
});

// Load scheduled posts and display retry count + status color
async function loadPosts() {
  const posts = await fetchJSON("/api/posts");
  const tbody = document.querySelector("#postsTable tbody");
  tbody.innerHTML = "";

  posts.forEach(post => {
    const row = document.createElement("tr");

    let statusColor = "black";
    switch (post.status) {
      case "scheduled": statusColor = "#007bff"; break;
      case "published": statusColor = "#28a745"; break;
      case "failed": statusColor = "#dc3545"; break;
      case "reminder": statusColor = "#ffc107"; break;
    }

    row.innerHTML = `
      <td><img src="${post.media_url}" alt="media"></td>
      <td>${post.caption}</td>
      <td>${new Date(post.scheduled_time).toLocaleString()}</td>
      <td>${post.page_name}</td>
      <td style="color:${statusColor}; font-weight:bold;">
        ${post.status}${post.error_message ? " — " + post.error_message : ""}${post.retry_count ? " (Retries: " + post.retry_count + ")" : ""}
      </td>
    `;
    tbody.appendChild(row);
  });
}

// Initial load
window.onload = async () => {
  await loadAccounts();
  await loadPosts();
  // Refresh posts every 30s to see status updates
  setInterval(loadPosts, 30000);
};
