import streamlit as st
import google.generativeai as genai

st.set_page_config(page_title="چت‌بات هوشمند", page_icon="🤖", layout="centered")

# استایل راست‌چین
st.markdown("""
    <style>
    .stApp, div[data-testid="stChatMessageContent"] {
        direction: rtl;
        text-align: right;
    }
    </style>
""", unsafe_allow_html=True)

st.title("🤖 چت‌بات هوشمند اختصاصی")

if "GEMINI_API_KEY" in st.secrets:
    API_KEY = st.secrets["GEMINI_API_KEY"]
else:
    API_KEY = "AQ.Ab8RN6LvWWYHswgDQ2U9N91EIEjyDNxS2M0sk6qO7wVxqOs_zw"

@st.cache_resource
def init_gemini():
    genai.configure(api_key=API_KEY)
    return genai.GenerativeModel(
        model_name='gemini-3.6-flash',
        system_instruction="تو یک دستیار بسیار هوشمند، صمیمی، دقیق و مسلط به زبان فارسی هستی."
    )

model = init_gemini()

if "chat_session" not in st.session_state:
    st.session_state.chat_session = model.start_chat(history=[])

if "messages" not in st.session_state:
    st.session_state.messages = []

if st.button("🗑️ پاک کردن گفتگو"):
    st.session_state.messages = []
    st.session_state.chat_session = model.start_chat(history=[])
    st.rerun()

# نمایش تاریخچه
for message in st.session_state.messages:
    with st.chat_message(message["role"]):
        st.markdown(message["content"])

# دریافت ورودی و تولید پاسخ زنده (Streaming)
if prompt := st.chat_input("پیام خود را بنویسید..."):
    st.chat_message("user").markdown(prompt)
    st.session_state.messages.append({"role": "user", "content": prompt})

    with st.chat_message("assistant"):
        # استفاده از send_message با قابلیت stream=True برای سرعت بالا
        response = st.session_state.chat_session.send_message(prompt, stream=True)
        
        def stream_generator():
            for chunk in response:
                yield chunk.text

        full_response = st.write_stream(stream_generator)
        
    st.session_state.messages.append({"role": "assistant", "content": full_response})