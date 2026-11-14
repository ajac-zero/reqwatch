export default {
  async fetch(): Promise<Response> {
    return new Response("reqwatch", { status: 200 });
  },
};
