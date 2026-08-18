export default {
  async fetch(request, env) {
    try {
      const { results } = await env.DB.prepare(
        "SELECT COUNT(*) AS total FROM procesos"
      ).all();

      return new Response(
        JSON.stringify({ success: true, procesos_en_d1: results[0].total }),
        { headers: { "Content-Type": "application/json" } }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ success: false, error: err.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  },
};
